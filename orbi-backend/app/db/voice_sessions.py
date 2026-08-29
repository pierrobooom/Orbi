"""Database queries for VoiceSession.

A VoiceSession groups the turns of a single voice-driven interaction
(usually a debrief) and stores the final structured extraction once the
debrief agent decides the conversation is complete.

Expected Supabase table:

    create table voice_sessions (
        id uuid primary key,
        user_id uuid not null references user_profiles(id),
        conversation_session_id uuid not null,
        kind text not null,             -- 'debrief' | 'capture' | 'query'
        status text not null,           -- 'active' | 'completed' | 'abandoned'
        topic text,
        started_at timestamptz not null,
        ended_at timestamptz,
        extraction jsonb,
        duration_seconds float
    );
"""

from uuid import UUID

from app.db.client import get_client


async def insert_voice_session(payload: dict) -> dict:
    """Create a new voice session and return the row."""
    response = (
        get_client().table("voice_sessions")
        .insert(payload)
        .execute()
    )
    return response.data[0]


async def fetch_voice_session(
    voice_session_id: UUID,
    user_id: UUID,
) -> dict | None:
    """Return a single voice session, or None if not owned by this user."""
    response = (
        get_client().table("voice_sessions")
        .select("*")
        .eq("id", str(voice_session_id))
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def update_voice_session(
    voice_session_id: UUID,
    user_id: UUID,
    payload: dict,
) -> dict | None:
    """Update fields on a voice session — typically status, ended_at, extraction."""
    response = (
        get_client().table("voice_sessions")
        .update(payload)
        .eq("id", str(voice_session_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return response.data[0] if response.data else None


async def fetch_recent_voice_sessions(
    user_id: UUID,
    limit: int = 20,
) -> list[dict]:
    """Return the user's most recent voice sessions, newest first."""
    response = (
        get_client().table("voice_sessions")
        .select("*")
        .eq("user_id", str(user_id))
        .order("started_at", desc=True)
        .limit(limit)
        .execute()
    )
    return response.data or []
