"""Database queries for finance_accounts, recurring_transactions and
bank_connections.

All functions interact directly with Supabase. No business logic lives here —
balances are derived in services/finance_balances.py, schedules are advanced in
services/recurring.py, and syncing is services/bank_sync.py.
"""

import logging
from datetime import date, datetime, timezone
from uuid import UUID

from app.db.client import get_client

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

async def list_accounts(owner_id: UUID, include_hidden: bool = True) -> list[dict]:
    """Return the user's accounts in display order."""
    query = (
        get_client().table("finance_accounts")
        .select("*")
        .eq("owner_id", str(owner_id))
    )
    if not include_hidden:
        query = query.eq("visible", True)
    response = query.order("position").order("created_at").execute()
    return response.data or []


async def fetch_account(account_id: UUID, owner_id: UUID) -> dict | None:
    """Return one account, or None. Scoped by owner — never trust the id alone."""
    response = (
        get_client().table("finance_accounts")
        .select("*")
        .eq("id", str(account_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def find_account_by_iban(owner_id: UUID, iban: str) -> dict | None:
    """Match an account by IBAN, for filing imported or synced transactions.

    This is the whole practical value of storing an IBAN: a statement names
    accounts by it, so a user who told us theirs never sees a "which account is
    this?" dialog.
    """
    normalised = normalise_iban(iban)
    if not normalised:
        return None
    response = (
        get_client().table("finance_accounts")
        .select("*")
        .eq("owner_id", str(owner_id))
        .eq("iban", normalised)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def insert_account(payload: dict) -> dict:
    response = get_client().table("finance_accounts").insert(payload).execute()
    return response.data[0]


async def update_account(account_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    payload = {**payload, "updated_at": _now_iso()}
    response = (
        get_client().table("finance_accounts")
        .update(payload)
        .eq("id", str(account_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def clear_primary(owner_id: UUID, except_id: UUID | None = None) -> None:
    """Demote every other account before promoting one.

    The partial unique index rejects a second primary, so the demotion has to
    happen first rather than being cleaned up afterwards.
    """
    query = (
        get_client().table("finance_accounts")
        .update({"is_primary": False, "updated_at": _now_iso()})
        .eq("owner_id", str(owner_id))
        .eq("is_primary", True)
    )
    if except_id:
        query = query.neq("id", str(except_id))
    query.execute()


async def delete_account(account_id: UUID, owner_id: UUID) -> bool:
    """Delete an account. Entries survive with account_id set to null.

    ON DELETE SET NULL rather than CASCADE is deliberate: deleting an account
    is a bookkeeping decision, and taking a year of spending history with it is
    never what the user meant.
    """
    response = (
        get_client().table("finance_accounts")
        .delete()
        .eq("id", str(account_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return bool(response.data)


def normalise_iban(value: str | None) -> str | None:
    """Upper-case, strip spaces. Returns None for empty input.

    Users type "PT50 0002 0123 1234 5678 9015 4" with the spaces their bank
    prints. Without normalisation the same account stored twice looks like two
    accounts and the unique index doesn't catch it.
    """
    if not value:
        return None
    cleaned = "".join(value.split()).upper()
    return cleaned or None


# ---------------------------------------------------------------------------
# Recurring transactions
# ---------------------------------------------------------------------------

async def list_recurring(owner_id: UUID, active_only: bool = False) -> list[dict]:
    query = (
        get_client().table("recurring_transactions")
        .select("*")
        .eq("owner_id", str(owner_id))
    )
    if active_only:
        query = query.eq("active", True)
    response = query.order("next_run_on").execute()
    return response.data or []


async def fetch_recurring(rule_id: UUID, owner_id: UUID) -> dict | None:
    response = (
        get_client().table("recurring_transactions")
        .select("*")
        .eq("id", str(rule_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def insert_recurring(payload: dict) -> dict:
    response = get_client().table("recurring_transactions").insert(payload).execute()
    return response.data[0]


async def update_recurring(rule_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    payload = {**payload, "updated_at": _now_iso()}
    response = (
        get_client().table("recurring_transactions")
        .update(payload)
        .eq("id", str(rule_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def delete_recurring(rule_id: UUID, owner_id: UUID) -> bool:
    response = (
        get_client().table("recurring_transactions")
        .delete()
        .eq("id", str(rule_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return bool(response.data)


async def fetch_due_recurring(today: date, limit: int = 500) -> list[dict]:
    """Active rules whose next run has arrived, oldest first.

    Ordered so a backlog after downtime is materialised in chronological
    order — a month of missed rent entries should land in the order they were
    owed, not in whatever order Postgres returns.
    """
    response = (
        get_client().table("recurring_transactions")
        .select("*")
        .eq("active", True)
        .lte("next_run_on", today.isoformat())
        .order("next_run_on")
        .limit(limit)
        .execute()
    )
    return response.data or []


# ---------------------------------------------------------------------------
# Bank connections
# ---------------------------------------------------------------------------

async def list_connections(owner_id: UUID) -> list[dict]:
    response = (
        get_client().table("bank_connections")
        .select("*")
        .eq("owner_id", str(owner_id))
        .order("created_at")
        .execute()
    )
    return response.data or []


async def fetch_connection(connection_id: UUID, owner_id: UUID) -> dict | None:
    response = (
        get_client().table("bank_connections")
        .select("*")
        .eq("id", str(connection_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def insert_connection(payload: dict) -> dict:
    response = get_client().table("bank_connections").insert(payload).execute()
    return response.data[0]


async def update_connection(connection_id: UUID, payload: dict) -> dict | None:
    payload = {**payload, "updated_at": _now_iso()}
    response = (
        get_client().table("bank_connections")
        .update(payload)
        .eq("id", str(connection_id))
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def delete_connection(connection_id: UUID, owner_id: UUID) -> bool:
    response = (
        get_client().table("bank_connections")
        .delete()
        .eq("id", str(connection_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return bool(response.data)


async def fetch_syncable_connections(now: datetime, limit: int = 100) -> list[dict]:
    """Active connections whose cooldown has elapsed.

    This query IS the one-call-per-account-per-day budget: a connection is
    invisible to the scheduler until next_sync_after passes, so the call rate
    is a property of the data rather than of how often anyone opens the app.
    """
    response = (
        get_client().table("bank_connections")
        .select("*")
        .eq("status", "active")
        .lte("next_sync_after", now.isoformat())
        .order("next_sync_after")
        .limit(limit)
        .execute()
    )
    return response.data or []


async def expiring_connections(before: datetime) -> list[dict]:
    """Active connections whose consent runs out before `before`.

    Used to warn the user while the feed still works. A connection that simply
    goes quiet is indistinguishable from a quiet month of spending, which is
    the worst possible failure mode for a finance app.
    """
    response = (
        get_client().table("bank_connections")
        .select("*")
        .eq("status", "active")
        .not_.is_("consent_expires_at", "null")
        .lte("consent_expires_at", before.isoformat())
        .execute()
    )
    return response.data or []


async def find_pending_connection_for_account(account_id: str) -> dict | None:
    """The still-unfinished connection for an account, if there is one.

    Used by the bank callback, which arrives as an unauthenticated browser
    redirect carrying only the `state` it was given. That state is the account
    id, so this is the lookup that turns it back into a connection.
    """
    response = (
        get_client().table("bank_connections")
        .select("*")
        .eq("account_id", str(account_id))
        .eq("status", "pending")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None
