"""Pull transactions from connected bank accounts, once a day each.

THE BUDGET IS THE DESIGN
Aggregators charge per connected account per month and several meter calls on
top, so the call rate has to be a property of the data rather than of how often
someone opens the app. `bank_connections.next_sync_after` is that property: the
scheduler can only see a connection whose cooldown has elapsed, and stamps the
next one immediately on claiming it. One account, one call, one day — no matter
how many devices the user has or how enthusiastically they pull-to-refresh.

WHY THE WINDOW OVERLAPS
Each sync asks for the last SYNC_WINDOW_DAYS, not "since we last looked". Banks
post transactions late — a card payment on Friday can appear on Tuesday with
Friday's date — so a non-overlapping window silently drops them, and the user
never learns that the number is wrong. Overlapping means the same transaction
arrives many times, which is free: the unique index on (user_id, external_id)
absorbs it.

WHAT THIS DOES NOT DO
It does not authenticate. Connecting an account means sending the user to their
own bank, where they authenticate and consent, and getting a token back; that
flow belongs to whichever provider is configured. An IBAN identifies the
account but authorises nothing, so a connection with no consent_reference
fetches nothing rather than pretending.
"""

import logging
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from app.db import finance as finance_db, finance_accounts as accounts_db
from app.services.bank_providers import (
    BankTransaction,
    ConsentExpired,
    get_provider,
)
from app.services.finance_categorizer import categorize_merchant

logger = logging.getLogger(__name__)

# How far back each sync looks. Generous enough to cover a long weekend of
# late postings plus a day the server was down, cheap because it is the same
# single call either way.
SYNC_WINDOW_DAYS = 7

# The gap between syncs of one account. The number the whole cost model rests
# on — raising it multiplies every user's provider bill.
SYNC_INTERVAL_HOURS = 24

# After a failure. Long enough not to hammer a provider having a bad morning,
# short enough that a transient outage doesn't cost a day of data.
RETRY_INTERVAL_HOURS = 3

# The floor for a refresh the user ASKED for, as opposed to the daily
# background one.
#
# These were the same number, and that was wrong. Someone who has just spent
# money, opened the app and pressed Update expects to see it; telling them to
# come back in twenty-two hours is not a cost control, it is a broken button.
# The daily cadence exists to bound the BACKGROUND cost, which nobody asked
# for. A deliberate tap is a different thing and gets its own, much shorter
# floor — still bounded, so holding the button down cannot run up a bill, and
# still far below any provider's rate limit.
MANUAL_REFRESH_MINUTES = 5

# Warn this far ahead of a consent expiring. PSD2 re-authentication is a trip
# to the banking app, so it needs to be asked for before the feed dies, not
# after — a stopped feed looks exactly like a month of not spending.
CONSENT_WARNING_DAYS = 7

_MAX_PER_TICK = 50


async def sync_user_now(owner_id: UUID, now: datetime | None = None) -> dict:
    """Sync this user's connections on demand, using the short manual floor.

    The background loop's daily cadence bounds a cost nobody asked for. A tap
    on Update is a request, and it gets MANUAL_REFRESH_MINUTES instead — still
    bounded, so repeated tapping cannot run up a provider bill, but responsive
    enough that a purchase made a minute ago shows up.
    """
    now = now or datetime.now(timezone.utc)
    floor = now - timedelta(minutes=MANUAL_REFRESH_MINUTES)

    connections = [
        c
        for c in await accounts_db.list_connections(owner_id)
        if c.get("status") == "active"
        and (
            not c.get("last_synced_at")
            or str(c["last_synced_at"]) <= floor.isoformat()
        )
    ]
    if not connections:
        return {"considered": 0, "imported": 0, "failed": 0, "throttled": True}

    imported = 0
    failed = 0
    for connection in connections:
        try:
            imported += await sync_connection(connection, now=now)
        except Exception as exc:  # noqa: BLE001 — one account must not stop the rest
            failed += 1
            logger.error("Manual sync failed for %s: %s", connection.get("id"), exc)

    return {
        "considered": len(connections),
        "imported": imported,
        "failed": failed,
        "throttled": False,
    }


async def sync_due_accounts(now: datetime | None = None) -> dict:
    """Sync every connection whose cooldown has elapsed.

    Returns a summary the scheduler can log: how many were considered, how
    many transactions were new, and how many connections failed.
    """
    now = now or datetime.now(timezone.utc)
    connections = await accounts_db.fetch_syncable_connections(now, limit=_MAX_PER_TICK)
    if not connections:
        return {"considered": 0, "imported": 0, "failed": 0}

    imported = 0
    failed = 0
    for connection in connections:
        try:
            imported += await sync_connection(connection, now=now)
        except Exception as exc:  # noqa: BLE001 — one account must not stop the rest
            failed += 1
            logger.error("Bank sync failed for connection %s: %s", connection.get("id"), exc)

    return {"considered": len(connections), "imported": imported, "failed": failed}


async def sync_connection(connection: dict, now: datetime | None = None) -> int:
    """Sync one connection. Returns how many NEW entries were written.

    The cooldown is stamped before the fetch, not after. A provider call that
    hangs for two minutes would otherwise leave the connection claimable by the
    next tick, and a provider that is slow for everyone would turn into a
    thundering herd against the exact API we are trying to call sparingly.
    """
    now = now or datetime.now(timezone.utc)
    connection_id = UUID(str(connection["id"]))
    owner_id = UUID(str(connection["owner_id"]))

    await accounts_db.update_connection(
        connection_id,
        {"next_sync_after": (now + timedelta(hours=SYNC_INTERVAL_HOURS)).isoformat()},
    )

    # A consent past its stated end is dead, and calling the provider to be
    # told so costs a metered request per account per day for as long as the
    # user ignores the reconnect prompt. The expiry date came from the
    # provider itself, so trusting it is not a guess.
    if _consent_has_lapsed(connection, now):
        await accounts_db.update_connection(
            connection_id,
            {
                "status": "expired",
                "last_error": "Consent expired — reconnect the account.",
            },
        )
        logger.info("Skipping connection %s — consent lapsed", connection_id)
        return 0

    provider = get_provider(connection.get("provider"))
    until = now.date()
    since = until - timedelta(days=SYNC_WINDOW_DAYS)

    try:
        transactions = await provider.fetch_transactions(
            external_account_id=connection.get("external_account_id"),
            consent_reference=connection.get("consent_reference"),
            since=since,
            until=until,
        )
    except ConsentExpired:
        # Terminal until the user acts. Marked rather than retried, because no
        # amount of retrying renews a consent — only the user can, at their
        # bank.
        await accounts_db.update_connection(
            connection_id,
            {
                "status": "expired",
                "last_error": "Consent expired — reconnect the account.",
            },
        )
        logger.info("Consent expired for connection %s", connection_id)
        return 0
    except Exception as exc:  # noqa: BLE001
        await accounts_db.update_connection(
            connection_id,
            {
                "status": "error",
                "last_error": str(exc)[:500],
                "next_sync_after": (now + timedelta(hours=RETRY_INTERVAL_HOURS)).isoformat(),
            },
        )
        raise

    written = await _store(
        transactions,
        owner_id=owner_id,
        account_id=connection.get("account_id"),
    )

    await accounts_db.update_connection(
        connection_id,
        {
            "status": "active",
            "last_synced_at": now.isoformat(),
            "last_error": None,
            # A working sync means this consent period is healthy, so any
            # warning already sent about it belongs to the previous one.
            # Without this, a reconnected account never warns again.
            "notified_state": None,
        },
    )
    if written:
        logger.info("Imported %s transactions for connection %s", written, connection_id)
    return written


async def _store(
    transactions: list[BankTransaction], *, owner_id: UUID, account_id
) -> int:
    """Write transactions that aren't already known. Returns the count written.

    Existing external_ids are read once up front rather than probed per row: a
    week's window is a handful of transactions, but the alternative is a query
    per transaction per account per day, which is the kind of thing that looks
    free until there are a thousand users.
    """
    if not transactions:
        return 0

    known = await finance_db.existing_external_ids(
        owner_id, [t.external_id for t in transactions]
    )

    # Providers return transactions newest-first, and bank feeds carry no
    # time — so this list order is the ONLY intra-day ordering that exists.
    # Reversing it means position 0 is the oldest, which makes a larger
    # sort_key mean "more recent", matching how the list is read.
    base = int(datetime.now(timezone.utc).timestamp() * 1000) * 1000
    ordered = list(reversed(transactions))

    rows = []
    for position, transaction in enumerate(ordered):
        if transaction.external_id in known:
            continue
        entry = _to_entry(transaction, owner_id=owner_id, account_id=account_id)
        entry["sort_key"] = base + position
        rows.append(entry)

    if not rows:
        return 0
    return await finance_db.insert_entries(rows)


def _to_entry(transaction: BankTransaction, *, owner_id: UUID, account_id) -> dict:
    """Turn a provider transaction into a finance_entries row.

    Categorisation runs on the merchant string here, using the same rule table
    the manual path uses — merchant rules first, AI only for what they miss.
    A bank feed is where those rules earn their keep: it produces hundreds of
    merchant strings a month, and every one a rule catches is an AI call that
    never happens.
    """
    is_expense = transaction.amount < 0
    merchant = transaction.merchant or transaction.description or "Unknown"

    return {
        "user_id": str(owner_id),
        "account_id": str(account_id) if account_id else None,
        # Stored unsigned; entry_type carries the direction, matching how
        # manually-created entries have always been shaped.
        "amount": abs(transaction.amount),
        "currency": transaction.currency,
        "merchant": merchant[:200],
        "category": categorize_merchant(merchant),
        "entry_type": "expense" if is_expense else "income",
        "entry_date": transaction.booked_on.isoformat(),
        "source_type": "bank",
        "external_id": transaction.external_id,
        "raw_description": (transaction.description or "")[:500],
    }


def _consent_has_lapsed(connection: dict, now: datetime) -> bool:
    """Is this connection's consent past its stated end?

    A missing or unparseable expiry means "don't know", which must read as
    not-lapsed: refusing to sync on a guess would break every provider that
    omits the field.
    """
    expires_at = connection.get("consent_expires_at")
    if not expires_at:
        return False
    try:
        parsed = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    return parsed <= now


async def connections_needing_attention(owner_id: UUID) -> list[dict]:
    """Connections the user has to do something about.

    Expired ones, errored ones, and ones expiring within the warning window —
    everything the finance screen should be surfacing rather than quietly
    showing a total that stopped updating last Tuesday.
    """
    cutoff = datetime.now(timezone.utc) + timedelta(days=CONSENT_WARNING_DAYS)
    connections = await accounts_db.list_connections(owner_id)

    needs: list[dict] = []
    for connection in connections:
        # "choose" belongs here too: the bank said yes, but until the user
        # picks an account nothing syncs, and nothing else will prompt them.
        if connection.get("status") in {"expired", "error", "revoked", "choose"}:
            needs.append(connection)
            continue
        expires_at = connection.get("consent_expires_at")
        if not expires_at:
            continue
        try:
            parsed = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed <= cutoff:
            needs.append(connection)
    return needs


def default_window(today: date | None = None) -> tuple[date, date]:
    """The date range a sync asks for. Exposed for tests and manual runs."""
    until = today or datetime.now(timezone.utc).date()
    return until - timedelta(days=SYNC_WINDOW_DAYS), until
