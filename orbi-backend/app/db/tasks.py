"""Database queries for TaskBubble.

All functions here interact directly with Supabase. No business logic lives
here — only query construction, execution, and result mapping.
"""

from uuid import UUID

from app.db.client import get_client
from app.models.task import TaskBubble, TaskBubbleCreate, TaskBubbleUpdate


async def fetch_tasks_for_user(user_id: UUID) -> list[dict]:
    """Return all non-archived tasks owned by user_id, ordered by pressure_score desc."""
    response = (
        get_client().table("task_bubbles")
        .select("*")
        .eq("owner_id", str(user_id))
        .neq("status", "archived")
        .order("pressure_score", desc=True)
        .execute()
    )
    return response.data or []


async def fetch_task_by_id(task_id: UUID, owner_id: UUID) -> dict | None:
    """Return a single task owned by owner_id, or None if not found."""
    response = (
        get_client().table("task_bubbles")
        .select("*")
        .eq("id", str(task_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def insert_task(payload: dict) -> dict:
    """Insert a new task row and return the created record."""
    response = get_client().table("task_bubbles").insert(payload).execute()
    return response.data[0]


async def update_task(task_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    """Apply a partial update to a task. Returns the updated record or None."""
    response = (
        get_client().table("task_bubbles")
        .update(payload)
        .eq("id", str(task_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return response.data[0] if response.data else None


async def archive_task(task_id: UUID, owner_id: UUID) -> bool:
    """Soft-delete a task by setting its status to archived. Returns True on success."""
    response = (
        get_client().table("task_bubbles")
        .update({"status": "archived"})
        .eq("id", str(task_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return bool(response.data)


async def search_tasks_by_embedding(
    owner_id: UUID,
    query_embedding: list[float],
    match_count: int = 25,
    match_threshold: float = 0.3,
) -> list[dict]:
    """Semantic similarity search over the user's task bubbles.

    Calls the search_task_bubbles_by_embedding RPC (migration 0006)
    which performs a pgvector cosine-similarity scan filtered by
    ownership and a min-similarity threshold. Archived tasks are
    excluded by the RPC. Default threshold 0.3 is loose enough to
    catch broader matches; the mobile can re-rank by similarity if
    needed.
    """
    response = (
        get_client().rpc(
            "search_task_bubbles_by_embedding",
            {
                "p_owner_id": str(owner_id),
                "p_embedding": query_embedding,
                "p_match_count": match_count,
                "p_match_threshold": match_threshold,
            },
        ).execute()
    )
    return response.data or []


async def fetch_tasks_without_embeddings(owner_id: UUID | None = None, limit: int = 100) -> list[dict]:
    """Return tasks whose embedding column is NULL.

    Used by the backfill script. When owner_id is None, scans all users
    (admin/cron path); when set, only that user's tasks. Limit caps the
    batch so the backfill can pace OpenAI calls.
    """
    query = (
        get_client().table("task_bubbles")
        .select("id, owner_id, title, label, description")
        .is_("embedding", "null")
        .limit(limit)
    )
    if owner_id is not None:
        query = query.eq("owner_id", str(owner_id))
    response = query.execute()
    return response.data or []
