"""Warn before a subscription renews, while the money is still the user's.

WHY THIS ONE MATTERS MORE THAN THE OTHERS
Every other notification in Orbi reports something that already happened —
you went over budget, the bank feed stopped, that task was due. This is the
only one that arrives while the outcome is still changeable. A gym contract
rolling into another year is the most expensive thing a finance app can fail
to mention, and the entire cost of missing it is that nobody looked at a
date.

FOUR DAYS, TWO DAYS, ONE DAY
Cancelling is rarely a tap. It is a phone call, a web form, sometimes a
visit — things that need a working day rather than an evening. A single
warning lands on a bad day and is forgotten; a daily countdown is nagging.
Three catches a busy week without becoming noise, and they get quieter as
they get closer, because by day one the useful message is short.

AND ONE AFTERWARDS
"This renewed today" is not a warning, it is a receipt. It is the message
that proves the feature works, and the one that prompts "actually, cancel it
before next month". It fires from the materialiser rather than from here,
because the only honest moment to say a thing renewed is when the entry for
it was written.

WHAT STOPS IT REPEATING
notified_stage holds the last warning sent, and notified_for holds the
occurrence it belongs to. Both are needed: a rule that renewed yesterday
would otherwise look like it had already been warned about for next month.
"""

import logging
from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID

from app.db import device_tokens as device_tokens_db
from app.db.client import get_client
from app.services.push import send_push
from app.services.reminder_schedule import in_quiet_hours, resolve_zone

logger = logging.getLogger(__name__)

# Days before renewal, and the stage each one records. Ordered nearest-first
# so a rule that has slipped past several thresholds — a server that was down
# for a week — sends the most urgent one rather than the earliest.
STAGES: list[tuple[int, str]] = [(1, "d1"), (2, "d2"), (4, "d4")]

# Once a stage is sent, the earlier ones are moot. "d1 already sent" must not
# be overwritten by a later sweep deciding d2 is due.
_RANK = {"d4": 1, "d2": 2, "d1": 3, "renewed": 4}

_COPY = {
    "en": {
        "d4": (
            "{merchant} renews in 4 days",
            "{amount} on {date}. Cancel before then if you don't want another {period}.",
        ),
        "d2": (
            "{merchant} renews in 2 days",
            "{amount} on {date}. Last chance to cancel is coming up.",
        ),
        "d1": (
            "{merchant} renews tomorrow",
            "{amount} will be charged on {date}.",
        ),
        "renewed": (
            "{merchant} renewed today",
            "{amount} charged. Cancel now if you don't want it again next {period}.",
        ),
    },
    "pt": {
        "d4": (
            "{merchant} renova daqui a 4 dias",
            "{amount} a {date}. Cancela antes se não quiseres outro {period}.",
        ),
        "d2": (
            "{merchant} renova daqui a 2 dias",
            "{amount} a {date}. Está a chegar a última oportunidade de cancelar.",
        ),
        "d1": (
            "{merchant} renova amanhã",
            "{amount} vão ser cobrados a {date}.",
        ),
        "renewed": (
            "{merchant} renovou hoje",
            "{amount} cobrados. Cancela agora se não quiseres outro {period}.",
        ),
    },
}

_PERIOD = {
    "en": {"weekly": "week", "monthly": "month", "yearly": "year"},
    "pt": {"weekly": "semana", "monthly": "mês", "yearly": "ano"},
}


def stage_for(next_run_on: date, today: date) -> str | None:
    """Which warning is due for a renewal on this date, if any.

    Pure, so the schedule can be argued about in a test rather than by
    waiting four days. Returns None when the renewal is further off than the
    first warning, or already past.
    """
    days = (next_run_on - today).days
    if days < 0:
        return None
    for threshold, stage in STAGES:
        if days <= threshold:
            return stage
    return None


def should_send(stage: str, already: str | None, notified_for, occurrence: date) -> bool:
    """Has this warning already gone out for this occurrence?

    The date matters as much as the stage: a rule that renewed yesterday and
    moved on would otherwise look like it had already been warned about for
    next month.
    """
    if str(notified_for or "") != occurrence.isoformat():
        return True
    if already is None:
        return True
    # Never step backwards. A sweep that decides d2 is due must not overwrite
    # a d1 that has already been sent.
    return _RANK.get(stage, 0) > _RANK.get(already, 0)


def _money(amount: float, currency: str) -> str:
    symbol = {"EUR": "€", "GBP": "£", "USD": "$"}.get(currency, "")
    return f"{symbol}{amount:.2f}"


async def notify_rule(rule: dict, stage: str, now: datetime) -> bool:
    """Send one renewal notification. Returns whether it reached a device."""
    from app.services.reminder_dispatcher import preferences_for

    owner_id = UUID(str(rule["owner_id"]))
    prefs = await preferences_for(owner_id)
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
        # Nothing about a renewal four days out is worth 3am, and waiting
        # until morning costs nothing — the next sweep picks it up.
        return False

    tokens = await device_tokens_db.list_tokens_for_user(owner_id)
    if not tokens:
        return False

    language = (prefs.get("language") or "en").lower()
    lang = "pt" if language.startswith("pt") else "en"
    title_template, body_template = _COPY[lang][stage]

    renews_on = date.fromisoformat(str(rule["next_run_on"]))
    values = {
        "merchant": rule.get("merchant") or "A subscription",
        "amount": _money(float(rule.get("amount") or 0), rule.get("currency") or "EUR"),
        "date": renews_on.strftime("%d %b"),
        "period": _PERIOD[lang].get(rule.get("cadence") or "monthly", ""),
    }

    tickets = await send_push(
        tokens,
        title=title_template.format(**values),
        body=body_template.format(**values),
        # Time-sensitive: the window to act on this closes, and it closes on
        # a date the user did not choose.
        interruption_level="time-sensitive",
        data={
            "kind": "membership",
            "recurring_id": str(rule["id"]),
            "stage": stage,
        },
    )
    if not any(t.get("status") == "ok" for t in tickets):
        logger.warning("Membership alert rejected for %s", rule.get("id"))
        return False

    get_client().table("recurring_transactions").update(
        {"notified_stage": stage, "notified_for": renews_on.isoformat()}
    ).eq("id", str(rule["id"])).execute()
    return True


async def run_membership_alerts(now: datetime | None = None) -> dict:
    """Sweep active rules and warn about the ones renewing soon."""
    now = now or datetime.now(timezone.utc)
    today = now.date()
    horizon = today + timedelta(days=STAGES[-1][0])

    rows = (
        get_client()
        .table("recurring_transactions")
        .select("*")
        .eq("active", True)
        .eq("notify_enabled", True)
        .lte("next_run_on", horizon.isoformat())
        .gte("next_run_on", today.isoformat())
        .execute()
        .data
        or []
    )
    if not rows:
        return {"checked": 0, "notified": 0}

    notified = 0
    for rule in rows:
        try:
            occurrence = date.fromisoformat(str(rule["next_run_on"]))
            stage = stage_for(occurrence, today)
            if stage is None:
                continue
            if not should_send(
                stage, rule.get("notified_stage"), rule.get("notified_for"), occurrence
            ):
                continue
            if await notify_rule(rule, stage, now):
                notified += 1
        except Exception as exc:  # noqa: BLE001 — one rule must not stop the rest
            logger.error("Membership alert failed for %s: %s", rule.get("id"), exc)

    return {"checked": len(rows), "notified": notified}


async def notify_renewed(rule: dict, now: datetime | None = None) -> bool:
    """Say that a subscription just renewed.

    Called by the materialiser rather than the sweep, because the only
    honest moment to claim something renewed is when the entry for it was
    actually written.
    """
    if not rule.get("notify_enabled", True):
        return False
    return await notify_rule(rule, "renewed", now or datetime.now(timezone.utc))
