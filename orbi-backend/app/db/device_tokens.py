"""Database queries for device_tokens.

All functions interact directly with Supabase. No business logic lives here —
the actual Expo Push API call belongs in app/services/push.py.
"""

from datetime import datetime, timezone
from uuid import UUID

from app.db.client import get_client


async def upsert_token(user_id: UUID, token: str, platform: str) -> dict:
    """Register or refresh a device token for the user.

    Upserts on (user_id, token) so a repeat registration just bumps
    last_seen_at instead of erroring on the unique constraint.
    """
    payload = {
        "user_id": str(user_id),
        "token": token,
        "platform": platform,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }
    response = (
        get_client().table("device_tokens")
        .upsert(payload, on_conflict="user_id,token")
        .execute()
    )
    return response.data[0]


async def delete_token(user_id: UUID, token: str) -> bool:
    """Remove a device token. Returns True if a row was deleted."""
    response = (
        get_client().table("device_tokens")
        .delete()
        .eq("user_id", str(user_id))
        .eq("token", token)
        .execute()
    )
    return bool(response.data)


async def list_tokens_for_user(user_id: UUID) -> list[str]:
    """Return all push tokens registered for this user, newest seen first."""
    response = (
        get_client().table("device_tokens")
        .select("token")
        .eq("user_id", str(user_id))
        .order("last_seen_at", desc=True)
        .execute()
    )
    return [row["token"] for row in (response.data or [])]
