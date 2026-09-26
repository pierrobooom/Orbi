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
    # A push token identifies a PHONE, and a phone belongs to whoever signed
    # in on it last. Without this, signing out and letting someone else sign
    # in left the token registered to both accounts, so the first person's
    # reminders — task titles and all — kept arriving on the second
    # person's phone. The newest registration takes the token.
    (
        get_client().table("device_tokens")
        .delete()
        .eq("token", token)
        .neq("user_id", str(user_id))
        .execute()
    )

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


async def delete_dead_token(token: str) -> None:
    """Remove a token Expo says no longer reaches any device, for everyone.

    DeviceNotRegistered means the app was uninstalled or the token rotated.
    Keeping it means every future reminder is sent to nowhere — and, if it
    was the user's only token, retried every minute until given up on.
    """
    get_client().table("device_tokens").delete().eq("token", token).execute()


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
