"""Database queries for ai_usage_counters.

All functions interact directly with Supabase. No business logic lives here —
period formatting, cap lookup, and quota decisions belong in
app/services/usage_tracker.py.
"""

from uuid import UUID

from app.db.client import get_client


async def fetch_counter(user_id: UUID, kind: str, period_key: str) -> int:
    """Return the current usage amount for this user/kind/period, or 0 if none.

    A missing row is treated as zero usage so the first call of a period does
    not need a separate insert path — record_usage() handles that via upsert.
    """
    response = (
        get_client().table("ai_usage_counters")
        .select("amount")
        .eq("user_id", str(user_id))
        .eq("kind", kind)
        .eq("period_key", period_key)
        .limit(1)
        .execute()
    )
    if not response.data:
        return 0
    return int(response.data[0]["amount"])


async def increment_counter(
    user_id: UUID,
    kind: str,
    period_key: str,
    amount: int,
) -> int:
    """Atomically add `amount` to the counter and return the new total.

    Uses a Postgres RPC (`increment_ai_usage`) so the increment is a single
    atomic statement — racing requests cannot lose updates the way a
    read-then-write pattern in Python would.
    """
    response = (
        get_client().rpc(
            "increment_ai_usage",
            {
                "p_user_id": str(user_id),
                "p_kind": kind,
                "p_period_key": period_key,
                "p_amount": amount,
            },
        ).execute()
    )
    return int(response.data)
