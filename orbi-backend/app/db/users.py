"""Database queries for UserProfile and UserPreference.

All functions interact directly with Supabase. No business logic lives here.
"""

from uuid import UUID

from app.db.client import get_client


async def fetch_profile(user_id: UUID) -> dict | None:
    """Return the user profile for user_id, or None if not found."""
    response = (
        get_client().table("user_profiles")
        .select("*")
        .eq("id", str(user_id))
        .single()
        .execute()
    )
    return response.data


async def upsert_profile(payload: dict) -> dict:
    """Create or update a user profile. Returns the saved record."""
    response = (
        get_client().table("user_profiles")
        .upsert(payload, on_conflict="id")
        .execute()
    )
    return response.data[0]


async def fetch_preferences(user_id: UUID) -> dict | None:
    """Return user preferences, or None if not yet configured."""
    response = (
        get_client().table("user_preferences")
        .select("*")
        .eq("user_id", str(user_id))
        .single()
        .execute()
    )
    return response.data


async def upsert_preferences(payload: dict) -> dict:
    """Create or update user preferences. Returns the saved record."""
    response = (
        get_client().table("user_preferences")
        .upsert(payload, on_conflict="user_id")
        .execute()
    )
    return response.data[0]
