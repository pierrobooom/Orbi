"""Database queries for FinanceEntry and FinanceBudget.

All functions interact directly with Supabase. No business logic lives here.
"""

import logging
from uuid import UUID

from app.db.client import get_client

logger = logging.getLogger(__name__)


async def fetch_entries_for_user(
    user_id: UUID,
    category: str | None = None,
    month: str | None = None,
) -> list[dict]:
    """Return finance entries for the user, with optional filters.

    Args:
        user_id:  Owner of the entries.
        category: Filter by exact category name, e.g. "groceries".
        month:    Filter by month in YYYY-MM format, e.g. "2026-04".
    """
    query = (
        get_client().table("finance_entries")
        .select("*")
        .eq("user_id", str(user_id))
        .order("entry_date", desc=True)
    )

    if category:
        query = query.eq("category", category.lower())

    if month:
        # Match entries where entry_date starts with the given YYYY-MM prefix
        query = query.gte("entry_date", f"{month}-01").lt(
            "entry_date", _next_month(month)
        )

    response = query.execute()
    return response.data or []


async def insert_entry(payload: dict) -> dict:
    """Insert a new finance entry and return the created record."""
    response = get_client().table("finance_entries").insert(payload).execute()
    return response.data[0]


async def fetch_entry_by_id(entry_id: UUID, user_id: UUID) -> dict | None:
    """Return the entry for entry_id if it belongs to user_id, else None."""
    response = (
        get_client().table("finance_entries")
        .select("*")
        .eq("id", str(entry_id))
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
    )
    return response.data[0] if response.data else None


async def update_entry(entry_id: UUID, user_id: UUID, payload: dict) -> dict | None:
    """Update fields on an entry the user owns. Returns the new row or None."""
    response = (
        get_client().table("finance_entries")
        .update(payload)
        .eq("id", str(entry_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    if not response.data:
        return None
    return response.data[0]


async def delete_entry(entry_id: UUID, user_id: UUID) -> bool:
    """Delete an entry the user owns. Returns True if a row was deleted."""
    response = (
        get_client().table("finance_entries")
        .delete()
        .eq("id", str(entry_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return bool(response.data)


async def fetch_budgets_for_user(user_id: UUID) -> list[dict]:
    """Return all budget envelopes for the user."""
    response = (
        get_client().table("finance_budgets")
        .select("*")
        .eq("user_id", str(user_id))
        .execute()
    )
    return response.data or []


async def upsert_budget(payload: dict) -> dict:
    """Create or update a budget envelope for a category.

    Uses upsert on (user_id, category) so calling POST with an existing
    category updates the limit rather than creating a duplicate.
    """
    response = (
        get_client().table("finance_budgets")
        .upsert(payload, on_conflict="user_id,category")
        .execute()
    )
    return response.data[0]


def _next_month(month: str) -> str:
    """Return the first day of the month following YYYY-MM as a YYYY-MM-DD string.

    Used to build an exclusive upper bound for month-range queries.
    """
    year, month_num = int(month[:4]), int(month[5:7])
    if month_num == 12:
        return f"{year + 1}-01-01"
    return f"{year}-{month_num + 1:02d}-01"


async def existing_external_ids(user_id: UUID, external_ids: list[str]) -> set[str]:
    """Which of these provider transaction ids are already stored.

    Read in one query rather than probed per transaction: a sync window is a
    handful of rows, but the per-row alternative is a query per transaction per
    account per day, which looks free until there are a thousand users.
    """
    if not external_ids:
        return set()
    response = (
        get_client().table("finance_entries")
        .select("external_id")
        .eq("user_id", str(user_id))
        .in_("external_id", external_ids)
        .execute()
    )
    return {row["external_id"] for row in (response.data or []) if row.get("external_id")}


async def insert_entries(rows: list[dict]) -> int:
    """Bulk-insert entries. Returns how many landed.

    Tolerates the unique index on (user_id, external_id) rejecting the batch:
    a concurrent sync writing the same transaction first is the index doing its
    job, not an error worth propagating to a background scheduler.
    """
    if not rows:
        return 0
    try:
        response = get_client().table("finance_entries").insert(rows).execute()
        return len(response.data or [])
    except Exception as exc:  # noqa: BLE001
        logger.info("Bulk entry insert rejected (likely a duplicate): %s", exc)
        return 0


async def delete_budget(budget_id: UUID, user_id: UUID) -> bool:
    """Remove a spending limit. Returns True if a row was deleted."""
    response = (
        get_client().table("finance_budgets")
        .delete()
        .eq("id", str(budget_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return bool(response.data)


# ---------------------------------------------------------------------------
# Insights
# ---------------------------------------------------------------------------

async def fetch_insights(user_id: UUID, period: str) -> list[dict]:
    """Undismissed insights for a month, newest first."""
    response = (
        get_client().table("finance_insights")
        .select("*")
        .eq("user_id", str(user_id))
        .eq("period", period)
        .is_("dismissed_at", "null")
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


async def latest_insight_time(user_id: UUID, period: str) -> str | None:
    """When insights for this month were last generated, dismissed or not.

    Reads dismissed rows too: dismissing an observation is not a request for
    a fresh AI call, and ignoring them would let someone regenerate on demand
    by clearing the list.
    """
    response = (
        get_client().table("finance_insights")
        .select("created_at")
        .eq("user_id", str(user_id))
        .eq("period", period)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0]["created_at"] if rows else None


async def replace_insights(user_id: UUID, period: str, rows: list[dict]) -> int:
    """Swap a month's insights for a freshly generated set.

    Replace rather than append: appending turns the list into a growing pile
    of observations about the same month, most of them superseded.
    """
    client = get_client()
    client.table("finance_insights").delete().eq("user_id", str(user_id)).eq(
        "period", period
    ).execute()
    if not rows:
        return 0
    response = client.table("finance_insights").insert(rows).execute()
    return len(response.data or [])


async def dismiss_insight(insight_id: UUID, user_id: UUID) -> bool:
    """Hide one insight. Kept rather than deleted — see migration 0015."""
    from datetime import datetime as _dt, timezone as _tz

    response = (
        get_client().table("finance_insights")
        .update({"dismissed_at": _dt.now(_tz.utc).isoformat()})
        .eq("id", str(insight_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return bool(response.data)


async def entries_in_window(
    user_id: UUID,
    account_id: str | None,
    since: str,
    until: str,
) -> list[dict]:
    """Bank entries already stored for this account over a date range.

    Used to reconcile an incoming sync against what is already known. Scoped
    to source_type='bank' so a manually typed coffee is never mistaken for a
    bank row and silently suppressed.
    """
    query = (
        get_client().table("finance_entries")
        .select("id,amount,entry_date,merchant,raw_description,external_id")
        .eq("user_id", str(user_id))
        .eq("source_type", "bank")
        .gte("entry_date", since)
        .lte("entry_date", until)
    )
    if account_id:
        query = query.eq("account_id", str(account_id))
    return query.execute().data or []


async def delete_entries(entry_ids: list[str], user_id: UUID) -> int:
    """Delete several entries at once, scoped to their owner.

    Scoped by user_id as well as id, the same guard delete_entry carries: a
    stale or mistaken id must not be able to reach another person's ledger.
    """
    if not entry_ids:
        return 0
    rows = (
        get_client()
        .table("finance_entries")
        .delete()
        .in_("id", entry_ids)
        .eq("user_id", str(user_id))
        .execute()
        .data
        or []
    )
    return len(rows)
