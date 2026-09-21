"""Tell the user before their bank feed goes quiet, and once after it does.

THE FAILURE THIS EXISTS FOR
PSD2 consent expires — 90 or 180 days, depending on the bank — and when it
does the provider simply stops returning transactions. Nothing errors. The
sync runs, finds nothing, and the app goes on showing a monthly total that
stopped being true a fortnight ago.

That is the worst failure mode a finance app has, because a stopped feed and
a quiet month produce the same screen. The user has no way to tell them
apart, so they trust the number. Every other bug in the finance code makes
something look wrong; this one makes something wrong look fine.

TWO MESSAGES, BECAUSE THEY ASK FOR DIFFERENT THINGS
Before expiry: "this ends on Friday, renew it now" — the user can act while
the data is still flowing, and re-authorising early costs them nothing.
After: "this has stopped, and here is what you are missing" — a different
message, because the damage is now retrospective and they need to know the
totals have a hole in them.

Nothing more than that. An app that nags weekly about a bank connection is
one where the user turns off notifications, and then it cannot tell them
about the next thing either. `bank_connections.notified_state` holds which
of the two has been said, so an hourly sweep re-reading the same connection
stays silent.

WHAT THIS DOES NOT SPEND
Not the reminder budget. Task nudges are rationed by proactivity level
because there can be dozens; this is at most two notifications per consent
period, months apart, and suppressing one because the user had a busy
morning would hide the only message that invalidates their numbers.

It does respect quiet hours: a consent that lapses at 3am can be mentioned
at 8.
"""

import logging
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from app.db import device_tokens as device_tokens_db
from app.db.client import get_client
from app.services.push import send_push
from app.services.reminder_schedule import in_quiet_hours, resolve_zone

logger = logging.getLogger(__name__)

# How long before expiry to ask for a renewal. Re-authorising is a trip to
# the banking app and possibly a card reader, so it needs to land while the
# user still has slack — not on the morning the feed dies.
WARNING_DAYS = 7

# States that mean the feed has already stopped. 'error' is deliberately not
# here: a provider having a bad morning is retried, and telling the user to
# reconnect over a transient 500 trains them to ignore the message that
# matters.
_DEAD_STATES = {"expired", "revoked"}

_COPY = {
    "en": {
        "expiring": (
            "{account} needs reconnecting",
            "Your bank's permission ends {when}. Reconnect now and nothing stops.",
        ),
        "dead": (
            "{account} has stopped updating",
            "Your bank's permission expired, so new transactions aren't arriving. "
            "Reconnect to bring it back.",
        ),
    },
    "pt": {
        "expiring": (
            "{account} precisa de ser religada",
            "A autorização do teu banco termina {when}. Religa agora e nada pára.",
        ),
        "dead": (
            "{account} deixou de actualizar",
            "A autorização do teu banco expirou, por isso não chegam novos "
            "movimentos. Religa para voltar a receber.",
        ),
    },
}

_WHEN = {
    "en": {"today": "today", "tomorrow": "tomorrow", "days": "in {n} days"},
    "pt": {"today": "hoje", "tomorrow": "amanhã", "days": "daqui a {n} dias"},
}


def _parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def classify(connection: dict, now: datetime) -> str | None:
    """Which warning this connection is owed, if any.

    Returns 'dead', 'expiring' or None. Pure, so the decision is testable
    without a database or a push provider — and the decision is the part
    worth getting right.
    """
    already = connection.get("notified_state")

    if connection.get("status") in _DEAD_STATES:
        # 'dead' is still worth saying to someone already warned it was
        # coming: the first message was a chance to prevent this, the second
        # is news that their totals now have a hole in them.
        return None if already == "dead" else "dead"

    if connection.get("status") != "active":
        # Pending connections have never worked, so there is nothing to warn
        # about losing. The accounts screen already shows them as unfinished.
        return None

    expires_at = _parse_time(connection.get("consent_expires_at"))
    if expires_at is None:
        # No stated expiry. Some providers omit it; warning on a guess would
        # send people to their bank for no reason.
        return None

    if expires_at <= now:
        # Past its stated expiry but the sync has not tried since, so the
        # status is stale rather than wrong. It is dead either way.
        return None if already == "dead" else "dead"

    if expires_at - now <= timedelta(days=WARNING_DAYS):
        return None if already in {"expiring", "dead"} else "expiring"

    return None


def describe_when(expires_at: datetime | None, now: datetime, language: str) -> str:
    """"today" / "tomorrow" / "in 5 days" — never a raw timestamp.

    A date needs mental arithmetic to become urgency. The whole point of the
    early warning is that the user acts on it now.
    """
    words = _WHEN["pt"] if language.startswith("pt") else _WHEN["en"]
    if expires_at is None:
        return words["days"].format(n=WARNING_DAYS)
    days = (expires_at.date() - now.date()).days
    if days <= 0:
        return words["today"]
    if days == 1:
        return words["tomorrow"]
    return words["days"].format(n=days)


async def run_connection_alerts(now: datetime | None = None) -> dict:
    """Sweep every bank connection and notify the ones newly needing action."""
    now = now or datetime.now(timezone.utc)
    client = get_client()

    rows = (
        client.table("bank_connections")
        .select("*")
        .in_("status", ["active", "expired", "revoked"])
        .execute()
        .data
        or []
    )
    if not rows:
        return {"checked": 0, "notified": 0}

    notified = 0
    for connection in rows:
        kind = classify(connection, now)
        if kind is None:
            continue
        try:
            if await _notify(connection, kind, now):
                notified += 1
        except Exception as exc:  # noqa: BLE001 — one connection must not stop the rest
            logger.error(
                "Connection alert failed for %s: %s", connection.get("id"), exc
            )

    return {"checked": len(rows), "notified": notified}


async def _notify(connection: dict, kind: str, now: datetime) -> bool:
    """Send one alert. Returns whether it actually reached a device."""
    from app.services.reminder_dispatcher import preferences_for

    user_id = UUID(str(connection["owner_id"]))
    prefs = await preferences_for(user_id)
    if not prefs.get("reminders_enabled", True):
        return False

    zone = resolve_zone(prefs.get("timezone"))

    def _parse(value, fallback):
        try:
            return time.fromisoformat(str(value))
        except (ValueError, TypeError):
            return fallback

    if in_quiet_hours(
        now.astimezone(zone),
        _parse(prefs.get("quiet_hours_start"), time(22, 0)),
        _parse(prefs.get("quiet_hours_end"), time(8, 0)),
    ):
        # No deadline is missed by waiting — the next tick picks it up.
        return False

    tokens = await device_tokens_db.list_tokens_for_user(user_id)
    if not tokens:
        # Leave notified_state untouched so the alert is still owed once a
        # device exists, rather than being marked as sent to nobody.
        return False

    client = get_client()
    account = (
        client.table("finance_accounts")
        .select("name")
        .eq("id", str(connection["account_id"]))
        .limit(1)
        .execute()
        .data
        or [{}]
    )
    account_name = account[0].get("name") or "Your account"

    language = (prefs.get("language") or "en").lower()
    copy = _COPY["pt"] if language.startswith("pt") else _COPY["en"]
    title_template, body_template = copy[kind]

    values = {
        "account": account_name,
        "when": describe_when(
            _parse_time(connection.get("consent_expires_at")), now, language
        ),
    }

    tickets = await send_push(
        tokens,
        title=title_template.format(**values),
        body=body_template.format(**values),
        # Time-sensitive: a consent that lapses unnoticed silently corrupts
        # every figure in the app, and the window to prevent it is short.
        interruption_level="time-sensitive",
        data={
            "kind": "bank_connection",
            "connection_id": str(connection["id"]),
            "account_id": str(connection["account_id"]),
            "state": kind,
        },
    )
    if not any(t.get("status") == "ok" for t in tickets):
        logger.warning("Connection alert rejected for %s", connection.get("id"))
        return False

    # Recorded only after a ticket came back ok, so a rejected push is retried
    # next tick rather than silently marked delivered.
    client.table("bank_connections").update(
        {"notified_state": kind, "notified_at": now.isoformat()}
    ).eq("id", str(connection["id"])).execute()
    return True
