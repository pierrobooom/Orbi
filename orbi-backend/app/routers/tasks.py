"""Task router — CRUD endpoints for TaskBubble.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel

from app.agents.task_updater import parse_voice_update
from app.db import tasks as tasks_db, users as users_db
from app.models.task import TaskBubble, TaskBubbleCreate, TaskBubbleUpdate, TaskStatus
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.embeddings import generate_embedding
from app.services.scoring import calculate_pressure_score
from app.services.task_embedding import regenerate_task_embedding
from app.services.task_sanitizer import derive_label_from_title

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["tasks"])


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
    background_tasks: BackgroundTasks,
    user_id: UUID = Depends(get_current_user),
):
    """Create a new TaskBubble.

    owner_id is always taken from the auth token — never trusted from the
    request body. Pressure score is calculated immediately on creation.
    The semantic-search embedding is generated AFTER the response is
    returned via FastAPI's BackgroundTasks so the create stays fast.
    """
    now = datetime.now(timezone.utc)
    task_id = uuid4()

    # Auto-derive label from title when the client (or LLM upstream)
    # didn't supply one. Mirrors the JS shortLabel so legacy clients
    # and typed creates still get a sensible bubble label.
    label = body.label.strip() if body.label and body.label.strip() else None
    if label is None:
        derived = derive_label_from_title(body.title)
        label = derived or None

    # Build a full TaskBubble so the scoring function has all required fields
    task = TaskBubble(
        id=task_id,
        owner_id=user_id,  # enforce ownership from token, not body
        title=body.title,
        label=label,
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
    # Generate the search embedding off-thread — we never make the
    # create response wait on an OpenAI round-trip.
    background_tasks.add_task(regenerate_task_embedding, task_id, user_id)
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
    background_tasks: BackgroundTasks,
    user_id: UUID = Depends(get_current_user),
):
    """Partially update a task and recalculate its pressure score.

    Re-embeds the task on title / label / description changes so search
    stays current. Other field changes (status, due_at, etc.) don't
    affect the embedding so we skip the OpenAI call for them.
    """
    existing = await tasks_db.fetch_task_by_id(task_id, user_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    # exclude_unset, NOT exclude_none. PATCH semantics distinguish "field
    # absent" (leave alone) from "field explicitly null" (clear it), and
    # exclude_none collapses both into "leave alone" — which made it
    # impossible to clear a due date, drop a description, or move a task
    # out of its cluster into Drift. The write silently no-opped and the
    # client showed a success.
    changes = body.model_dump(exclude_unset=True)
    merged = TaskBubble(**{**existing, **changes})
    merged_dict = merged.model_dump(mode="json")
    merged_dict["updated_at"] = datetime.now(timezone.utc).isoformat()
    merged_dict["pressure_score"] = calculate_pressure_score(merged)

    # Only send changed fields + updated_at + pressure_score to the DB
    update_payload = body.model_dump(exclude_unset=True, mode="json")
    update_payload["updated_at"] = merged_dict["updated_at"]
    update_payload["pressure_score"] = merged_dict["pressure_score"]

    # Stamp completion on the transition, not on every write. Setting it
    # whenever status == 'completed' would push the date forward every
    # time a finished task was edited, which is exactly the bug that made
    # updated_at unusable as a completion time.
    if "status" in changes:
        was_completed = existing.get("status") == "completed"
        now_completed = changes["status"] == "completed"
        if now_completed and not was_completed:
            update_payload["completed_at"] = merged_dict["updated_at"]
        elif was_completed and not now_completed:
            # Re-opened — drop the old date rather than leave it lying.
            update_payload["completed_at"] = None

    row = await tasks_db.update_task(task_id, user_id, update_payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    # Re-embed only when one of the searchable fields actually changed
    # — saves an OpenAI call on status/due_at/importance edits.
    if any(k in changes for k in ("title", "label", "description")):
        background_tasks.add_task(regenerate_task_embedding, task_id, user_id)

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


# ---------------------------------------------------------------------------
# Voice-driven update — parse a spoken instruction into a field-level patch
# ---------------------------------------------------------------------------

class VoiceUpdateRequest(BaseModel):
    transcript: str
    user_timezone: Optional[str] = None


class VoiceUpdateResponse(BaseModel):
    # Sparse patch — only the fields the LLM thought should change.
    # Mobile applies it via the existing PATCH endpoint after the user
    # reviews it, so we DON'T mutate the row here.
    patch: dict
    reply: str


@router.post("/{task_id}/voice-update", response_model=VoiceUpdateResponse)
async def voice_update_task(
    task_id: UUID,
    body: VoiceUpdateRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Parse a spoken instruction into a partial task update.

    Read-only on the server — the mobile client receives the patch,
    pre-fills its edit form with the proposed changes, and the user
    taps Save to actually commit. This keeps the user in the loop and
    avoids surprise mutations from a misheard transcript.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    task = await tasks_db.fetch_task_by_id(task_id, user_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    if not body.transcript or not body.transcript.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("Transcript is empty.", "TRANSCRIPT_EMPTY"),
        )

    result = await parse_voice_update(
        current_task=task,
        user_message=body.transcript,
        user_id=user_id,
        user_tier=user_tier,
        user_timezone=body.user_timezone,
    )
    return VoiceUpdateResponse(patch=result["patch"], reply=result["reply"])


class DraftTask(BaseModel):
    """A task the user is still confirming — no DB row exists yet."""

    title: str
    label: Optional[str] = None
    description: Optional[str] = None
    due_at: Optional[str] = None
    importance: Optional[int] = None


class DraftVoiceUpdateRequest(BaseModel):
    draft: DraftTask
    transcript: str
    user_timezone: Optional[str] = None
    language: Optional[str] = None


@router.post("/draft-voice-update", response_model=VoiceUpdateResponse)
async def draft_voice_update(
    body: DraftVoiceUpdateRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Apply a spoken correction to a task that has not been created yet.

    The sibling /{task_id}/voice-update only exists for saved tasks: it
    loads the row, and its whole point is producing a patch against
    stored state. But the most natural moment to fix a misheard capture
    is BEFORE saving it — the user is looking at the parse and can see
    exactly what's wrong. There is no id to address at that point, so
    the client sends the draft itself.

    Nothing is written here; the response is a patch the confirm screen
    merges into its pending task. Same agent as the saved-task path, so
    "make it Tuesday at 9" behaves identically either side of the save.

    Declared before the /{task_id} routes so the path-param matcher
    can't swallow "draft-voice-update" as a task id.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    if not body.transcript or not body.transcript.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("Transcript is empty.", "TRANSCRIPT_EMPTY"),
        )

    language = body.language
    if not language:
        try:
            prefs = await users_db.fetch_preferences(user_id)
            language = (prefs or {}).get("language")
        except Exception as exc:  # noqa: BLE001 — never block the edit
            logger.warning("Could not read language preference: %s", exc)
            language = None

    result = await parse_voice_update(
        current_task=body.draft.model_dump(mode="json"),
        user_message=body.transcript,
        user_id=user_id,
        user_tier=user_tier,
        user_timezone=body.user_timezone,
        language=language,
    )
    return VoiceUpdateResponse(patch=result["patch"], reply=result["reply"])


# ---------------------------------------------------------------------------
# Semantic search — embed query, cosine-match against task embeddings
# ---------------------------------------------------------------------------


class TaskSearchRequest(BaseModel):
    query: str
    # Caps the returned set so the mobile doesn't have to filter a huge
    # list itself. 25 is enough for any one user's relevant matches.
    limit: int = 25


class TaskSearchHit(BaseModel):
    id: UUID
    title: str
    label: Optional[str] = None
    similarity: float
    parent_cluster_id: Optional[UUID] = None


class TaskSearchResponse(BaseModel):
    query: str
    # If the query produced no embedding (OpenAI down, empty input)
    # the mobile uses this flag to show a different empty state than
    # "no matches found". Hits is always a list, never null.
    embedded: bool
    hits: list[TaskSearchHit]


@router.post("/search", response_model=TaskSearchResponse)
async def search_tasks(
    body: TaskSearchRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Semantic search across the caller's active tasks.

    Embeds the query via OpenAI, runs a pgvector cosine-similarity
    scan, and returns matched tasks ranked by relevance. Tasks
    without an embedding (created before the backfill, or where
    generation failed) are excluded — the next update or a backfill
    pass will make them searchable.
    """
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("Query is empty.", "QUERY_EMPTY"),
        )

    embedding = await generate_embedding(q)
    if embedding is None:
        # Embedding failed (OpenAI hiccup, missing key). Return an
        # empty result with embedded=false so the mobile can surface
        # a "search unavailable" message rather than "no matches".
        return TaskSearchResponse(query=q, embedded=False, hits=[])

    rows = await tasks_db.search_tasks_by_embedding(
        owner_id=user_id,
        query_embedding=embedding,
        match_count=max(1, min(body.limit, 50)),
    )
    hits = [
        TaskSearchHit(
            id=row["id"],
            title=row.get("title") or "",
            label=row.get("label"),
            similarity=row.get("similarity") or 0.0,
            parent_cluster_id=row.get("parent_cluster_id"),
        )
        for row in rows
    ]
    return TaskSearchResponse(query=q, embedded=True, hits=hits)
