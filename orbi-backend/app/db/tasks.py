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
        .single()
        .execute()
    )
    return response.data


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
