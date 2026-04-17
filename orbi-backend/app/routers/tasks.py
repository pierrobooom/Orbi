"""Task router — CRUD endpoints for TaskBubble.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.db import tasks as tasks_db
from app.models.task import TaskBubble, TaskBubbleCreate, TaskBubbleUpdate, TaskStatus
from app.services.scoring import calculate_pressure_score

router = APIRouter(prefix="/tasks", tags=["tasks"])


# ---------------------------------------------------------------------------
# Auth placeholder — replace with real Supabase JWT verification next step
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str = Header(...)) -> UUID:
    """Extract user_id from the Authorization header.

    Placeholder implementation — returns a fixed UUID so all endpoints are
    exercisable before real JWT verification is wired in.
    Replace this with actual Supabase JWT decoding in app/services/auth.py.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Invalid authorization header.", "error_code": "AUTH_HEADER_INVALID"},
        )
    # TODO: decode and verify Supabase JWT, extract sub claim as user_id
    return UUID("00000000-0000-0000-0000-000000000001")


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=list[TaskBubble])
async def list_tasks(user_id: UUID = Depends(get_current_user)):
    """Return all active tasks for the authenticated user, ordered by pressure_score desc."""
    rows = await tasks_db.fetch_tasks_for_user(user_id)
    return rows


@router.post("", response_model=TaskBubble, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: TaskBubbleCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create a new TaskBubble.

    owner_id is always taken from the auth token — never trusted from the
    request body. Pressure score is calculated immediately on creation.
    """
    now = datetime.now(timezone.utc)
    task_id = uuid4()

    # Build a full TaskBubble so the scoring function has all required fields
    task = TaskBubble(
        id=task_id,
        owner_id=user_id,  # enforce ownership from token, not body
        title=body.title,
        description=body.description,
        status=body.status,
        due_at=body.due_at,
        importance=body.importance,
        urgency_score=body.urgency_score,
        pressure_score=0.0,
        domain_hint=body.domain_hint,
        parent_cluster_id=body.parent_cluster_id,
        source_type=body.source_type,
        confidence=body.confidence,
        visibility=body.visibility,
        created_at=now,
        updated_at=now,
    )

    pressure = calculate_pressure_score(task)

    payload = task.model_dump(mode="json")
    payload["pressure_score"] = pressure

    row = await tasks_db.insert_task(payload)
    return row


@router.get("/{task_id}", response_model=TaskBubble)
async def get_task(task_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Fetch a single task by ID. Returns 404 if not found or not owned by the user."""
    row = await tasks_db.fetch_task_by_id(task_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )
    return row


@router.patch("/{task_id}", response_model=TaskBubble)
async def update_task(
    task_id: UUID,
    body: TaskBubbleUpdate,
    user_id: UUID = Depends(get_current_user),
):
    """Partially update a task and recalculate its pressure score."""
    existing = await tasks_db.fetch_task_by_id(task_id, user_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    # Merge incoming changes onto the existing record to get a full TaskBubble
    # that the scoring function can operate on
    merged = TaskBubble(**{**existing, **body.model_dump(exclude_none=True)})
    merged_dict = merged.model_dump(mode="json")
    merged_dict["updated_at"] = datetime.now(timezone.utc).isoformat()
    merged_dict["pressure_score"] = calculate_pressure_score(merged)

    # Only send changed fields + updated_at + pressure_score to the DB
    update_payload = body.model_dump(exclude_none=True, mode="json")
    update_payload["updated_at"] = merged_dict["updated_at"]
    update_payload["pressure_score"] = merged_dict["pressure_score"]

    row = await tasks_db.update_task(task_id, user_id, update_payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )
    return row


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(task_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Soft-delete a task by setting its status to archived.

    Hard deletion is never performed — archived tasks are retained for memory
    synthesis and audit purposes.
    """
    success = await tasks_db.archive_task(task_id, user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )
