"""Database queries for FinanceEntry and FinanceBudget.

All functions interact directly with Supabase. No business logic lives here.
"""

from uuid import UUID

from app.db.client import get_client


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
