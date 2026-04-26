"""Database queries for ConversationEvent.

Stores the full transcript of user and assistant messages for debrief
extraction, memory synthesis, and audit purposes.
"""

from uuid import UUID

from app.db.client import get_client


async def fetch_conversation_history(
    user_id: UUID,
    session_id: UUID,
    limit: int = 50,
) -> list[dict]:
    """Return conversation events for a session, ordered chronologically."""
    response = (
        get_client().table("conversation_events")
        .select("*")
        .eq("user_id", str(user_id))
        .eq("session_id", str(session_id))
        .order("created_at", desc=False)
        .limit(limit)
        .execute()
    )
    return response.data or []


async def fetch_recent_sessions(user_id: UUID, limit: int = 10) -> list[dict]:
    """Return the most recent conversation sessions for a user.

    Groups by session_id and returns the latest message timestamp per session.
    Uses a simple approach: fetch recent events and deduplicate by session.
    """
    response = (
        get_client().table("conversation_events")
        .select("session_id, created_at")
        .eq("user_id", str(user_id))
        .order("created_at", desc=True)
        .limit(limit * 5)
        .execute()
    )

    seen = set()
    sessions = []
    for row in response.data or []:
        sid = row["session_id"]
        if sid not in seen:
            seen.add(sid)
            sessions.append(row)
            if len(sessions) >= limit:
                break
    return sessions


async def insert_conversation_event(payload: dict) -> dict:
    """Insert a new conversation event and return the created record."""
    response = (
        get_client().table("conversation_events")
        .insert(payload)
        .execute()
    )
    return response.data[0]


async def fetch_session_transcript(
    user_id: UUID,
    session_id: UUID,
) -> str:
    """Return the full session transcript as a formatted string.

    Used by the memory summarizer to extract facts from completed conversations.
    """
    events = await fetch_conversation_history(user_id, session_id)
    lines = [f"{e['role']}: {e['content']}" for e in events]
    return "\n".join(lines)
