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


async def fetch_task_by_id_any_owner(task_id: UUID) -> dict | None:
    """A task by id, without checking who owns it.

    For shared tasks: a participant is not the owner, so the owner-scoped
    read finds nothing for them. Callers MUST establish the right to see it
    first — via task_sharing.is_participant — because this function itself
    checks nothing.
    """
    rows = (
        get_client().table("task_bubbles")
        .select("*")
        .eq("id", str(task_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def fetch_shared_tasks_for_user(user_id: UUID) -> list[dict]:
    """Tasks other people have shared with this user and they accepted.

    Returned alongside their own so a shared task appears in their universe
    as a bubble like any other — which is the entire point of sharing one.
    Each row carries the share's own cluster_id, because where a task
    belongs is a personal filing decision: the same errand is "Work" to one
    person and "Home" to another.
    """
    shares = (
        get_client().table("task_shares")
        .select("task_id,cluster_id,shared_by_user_id,completed_at")
        .eq("shared_with_user_id", str(user_id))
        .eq("status", "accepted")
        .execute()
        .data
        or []
    )
    if not shares:
        return []

    by_task = {str(s["task_id"]): s for s in shares}
    rows = (
        get_client().table("task_bubbles")
        .select("*")
        .in_("id", list(by_task))
        .neq("status", "archived")
        .execute()
        .data
        or []
    )

    out = []
    for row in rows:
        share = by_task.get(str(row["id"]), {})
        out.append(
            {
                **row,
                # The recipient's filing wins over the owner's.
                "parent_cluster_id": share.get("cluster_id"),
                # Flags the UI needs to render it as somebody else's task
                # that this person is on, rather than as their own.
                "shared_with_me": True,
                "shared_by_user_id": share.get("shared_by_user_id"),
                "i_completed_at": share.get("completed_at"),
            }
        )
    return out
