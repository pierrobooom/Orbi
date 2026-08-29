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
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def update_profile(user_id: UUID, payload: dict) -> dict:
    """Update a user profile and return the saved record.

    The profile row is created at signup by the on_auth_user_created trigger
    (migrations/0003_user_profile_autocreate.sql), so this path is always an
    UPDATE — never an INSERT. Using PostgREST's .upsert() here would attempt
    an INSERT...ON CONFLICT DO UPDATE, which fails the email NOT NULL check
    on the proposed-INSERT row before ON CONFLICT can divert to UPDATE.
    """
    response = (
        get_client().table("user_profiles")
        .update(payload)
        .eq("id", str(user_id))
        .execute()
    )
    return response.data[0]


async def fetch_preferences(user_id: UUID) -> dict | None:
    """Return user preferences, or None if not yet configured.

    Uses limit(1) rather than single(). PostgREST's single() raises
    PGRST116 ("cannot coerce the result to a single JSON object") when
    there are zero rows, which surfaced as a 500 on the perfectly normal
    case of a user who has never saved preferences — and every caller
    here already treats None as "not configured".
    """
    response = (
        get_client().table("user_preferences")
        .select("*")
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def upsert_preferences(payload: dict) -> dict:
    """Create or update user preferences. Returns the saved record."""
    response = (
        get_client().table("user_preferences")
        .upsert(payload, on_conflict="user_id")
        .execute()
    )
    return response.data[0]
