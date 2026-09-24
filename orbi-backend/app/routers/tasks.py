"""Task router — CRUD endpoints for TaskBubble.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr

from app.agents.task_updater import parse_voice_update
from app.db import (
    notifications as notifications_db,
    tasks as tasks_db,
    users as users_db,
)
from app.models.task import (
    persistable,
    TaskBubble,
    TaskBubbleCreate,
    TaskBubbleUpdate,
    TaskStatus,
)
from app.services.ai_router import AIRateLimited
from app.services.usage_tracker import ObjectCapExceeded, check_bubble_cap
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.embeddings import generate_embedding
from app.db.client import get_client
from app.services import sharing_notify, task_sharing
from app.services.reminder_dispatcher import sync_task_plans
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
    """Active tasks for this user — their own, plus any shared with them.

    Shared tasks are merged in here rather than exposed on a separate
    endpoint so they land in the universe as ordinary bubbles. A shared task
    that needed its own screen to be seen would not be shared in any sense
    the user cares about.
    """
    own = await tasks_db.fetch_tasks_for_user(user_id)
    shared = await tasks_db.fetch_shared_tasks_for_user(user_id)
    return sorted(
        own + shared,
        key=lambda r: float(r.get("pressure_score") or 0),
        reverse=True,
    )


# ---------------------------------------------------------------------------
# Sharing
#
# Declared before the /{task_id} routes: FastAPI matches in registration
# order, so a static path registered later is swallowed by an earlier
# parameterised one.
# ---------------------------------------------------------------------------


class ShareRequest(BaseModel):
    """Who to share a task with."""

    email: EmailStr


class AcceptShareRequest(BaseModel):
    # Where the recipient wants it in THEIR universe. Optional: accepting
    # should not require also making a filing decision.
    cluster_id: Optional[UUID] = None


@router.get("/shared/incoming")
async def incoming_shares(user_id: UUID = Depends(get_current_user)):
    """Invitations waiting on this user, with the task attached.

    The task comes along because an invitation that only says "Ana shared a
    task" gives nobody enough to decide with.
    """
    rows = (
        get_client()
        .table("task_shares")
        .select("*")
        .eq("shared_with_user_id", str(user_id))
        .eq("status", "pending")
        .order("created_at", desc=True)
        .execute()
        .data
        or []
    )

    out = []
    for row in rows:
        task = await tasks_db.fetch_task_by_id_any_owner(UUID(str(row["task_id"])))
        if task is None:
            continue
        sender = await users_db.fetch_profile(UUID(str(row["shared_by_user_id"])))
        out.append(
            {
                "share": row,
                "task": task,
                "shared_by_name": (sender or {}).get("full_name"),
            }
        )
    return {"invitations": out}


@router.post("/{task_id}/share", status_code=status.HTTP_201_CREATED)
async def share_task(
    task_id: UUID,
    body: ShareRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Invite someone to a task by email address.

    The response NEVER says whether that address has an account. It would
    otherwise be a way to ask whether any given person uses Orbi, one address
    at a time, from any account. The invitation is created either way and is
    picked up when they sign up.
    """
    task = await tasks_db.fetch_task_by_id(task_id, user_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    email = body.email.strip().lower()
    owner = await users_db.fetch_profile(user_id)
    if owner and (owner.get("email") or "").lower() == email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("That is your own address.", "CANNOT_SHARE_WITH_SELF"),
        )

    recipient = await users_db.fetch_profile_by_email(email)
    client = get_client()

    existing = (
        client.table("task_shares")
        .select("*")
        .eq("task_id", str(task_id))
        .eq("invited_email", email)
        .limit(1)
        .execute()
        .data
        or []
    )
    if existing:
        row = existing[0]
        # A re-send of a declined or revoked invitation is a new ask, not an
        # error — people change their minds, and the alternative is telling
        # the sender they already asked, which leaks the answer.
        if row["status"] in {"declined", "revoked"}:
            client.table("task_shares").update(
                {"status": "pending", "completed_at": None}
            ).eq("id", row["id"]).execute()
        share_row = row
    else:
        share_row = (
            client.table("task_shares")
            .insert(
                {
                    "id": str(uuid4()),
                    "task_id": str(task_id),
                    "shared_by_user_id": str(user_id),
                    "invited_email": email,
                    "shared_with_user_id": str(recipient["id"]) if recipient else None,
                    "status": "pending",
                }
            )
            .execute()
            .data[0]
        )

    if recipient:
        await sharing_notify.invited(task, owner, UUID(str(recipient["id"])))

    return {"shared": True, "share_id": share_row["id"]}


@router.post("/shares/{share_id}/accept")
async def accept_share(
    share_id: UUID,
    body: AcceptShareRequest | None = None,
    user_id: UUID = Depends(get_current_user),
):
    """Join a shared task. It then appears in this user's universe."""
    row = await task_sharing.fetch_share_for_recipient(share_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Invitation not found.", "SHARE_NOT_FOUND"),
        )

    patch = {"status": "accepted"}
    if body and body.cluster_id:
        patch["cluster_id"] = str(body.cluster_id)

    updated = (
        get_client()
        .table("task_shares")
        .update(patch)
        .eq("id", str(share_id))
        .execute()
        .data
    )
    task = await tasks_db.fetch_task_by_id_any_owner(UUID(str(row["task_id"])))
    if task:
        joiner = await users_db.fetch_profile(user_id)
        await sharing_notify.joined(task, joiner, UUID(str(row["shared_by_user_id"])))
    return (updated or [row])[0]


@router.post("/shares/{share_id}/decline", status_code=status.HTTP_204_NO_CONTENT)
async def decline_share(share_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Turn an invitation down.

    The sender is not notified. Declining quietly is the point — a
    notification saying someone said no turns a small act into a social one.
    """
    row = await task_sharing.fetch_share_for_recipient(share_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Invitation not found.", "SHARE_NOT_FOUND"),
        )
    get_client().table("task_shares").update({"status": "declined"}).eq(
        "id", str(share_id)
    ).execute()


@router.get("/{task_id}/sharing")
async def task_sharing_state(
    task_id: UUID, user_id: UUID = Depends(get_current_user)
):
    """Who is on this task and where the completion vote stands."""
    task = await tasks_db.fetch_task_by_id(task_id, user_id)
    if task is None and not await task_sharing.is_participant(task_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )
    if task is None:
        task = await tasks_db.fetch_task_by_id_any_owner(task_id)

    shares = await task_sharing.shares_for_task(task_id)
    state = task_sharing.tally(bool((task or {}).get("owner_completed_at")), shares)
    return {"task_id": str(task_id), "shares": shares, **state}


@router.post("/{task_id}/complete")
async def complete_task(
    task_id: UUID,
    background_tasks: BackgroundTasks,
    user_id: UUID = Depends(get_current_user),
):
    """Say this task is done, on behalf of whoever is asking.

    On an unshared task this simply completes it. On a shared one it is a
    vote: the task closes for everybody once a majority of participants have
    said so, and until then the others are told they are being waited on.
    """
    task = await tasks_db.fetch_task_by_id(task_id, user_id)
    share = None if task else await task_sharing.is_participant(task_id, user_id)
    if task is None and share is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )
    if task is None:
        task = await tasks_db.fetch_task_by_id_any_owner(task_id)

    now = datetime.now(timezone.utc).isoformat()
    client = get_client()
    if share is not None:
        client.table("task_shares").update({"completed_at": now}).eq(
            "id", share["id"]
        ).execute()
    else:
        await tasks_db.update_task(task_id, user_id, {"owner_completed_at": now})
        task["owner_completed_at"] = now

    shares = await task_sharing.shares_for_task(task_id)
    state = task_sharing.tally(bool(task.get("owner_completed_at")), shares)

    if state["complete"]:
        # Completed by the OWNER's id, because that is who the row belongs to
        # and the normal completion path (plans cancelled, completed_at set)
        # is written in those terms.
        await tasks_db.update_task(
            task_id,
            UUID(str(task["owner_id"])),
            {"status": TaskStatus.completed.value, "completed_at": now},
        )
        background_tasks.add_task(sync_task_plans, {**task, "status": "completed"},
                                  UUID(str(task["owner_id"])))
        await sharing_notify.closed(task, shares, UUID(str(task["owner_id"])), user_id)
    elif state["participants"] > 1:
        voter = await users_db.fetch_profile(user_id)
        await sharing_notify.waiting_on_you(
            task, shares, UUID(str(task["owner_id"])), user_id, voter, state
        )

    return {"task_id": str(task_id), **state}


@router.post("", response_model=TaskBubble, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: TaskBubbleCreate,
    background_tasks: BackgroundTasks,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Create a new TaskBubble.

    owner_id is always taken from the auth token — never trusted from the
    request body. Pressure score is calculated immediately on creation.
    The semantic-search embedding is generated AFTER the response is
    returned via FastAPI's BackgroundTasks so the create stays fast.
    """
    user_id = auth["user_id"]

    # Tier cap, enforced server-side. The client checks this too for a
    # responsive UI, but the client is exactly the layer a determined user
    # controls — the API is reachable with any valid JWT.
    #
    # Counting active tasks (not all rows) is deliberate: completing a task
    # should free capacity, otherwise the cap becomes a lifetime quota and
    # a long-running Spark account silently dies.
    try:
        existing = await tasks_db.fetch_tasks_for_user(user_id)
        active_count = sum(1 for t in existing if t.get("status") == "active")
        check_bubble_cap(auth["tier"], active_count)
    except ObjectCapExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=_error(str(exc), "BUBBLE_CAP_REACHED"),
        )

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

    # persistable(), not model_dump(): the model carries four sharing fields
    # that are assembled per request from task_shares and are not columns.
    # Sending them made PostgREST reject the whole INSERT.
    payload = persistable(task)
    payload["pressure_score"] = pressure

    row = await tasks_db.insert_task(payload)
    # Generate the search embedding off-thread — we never make the
    # create response wait on an OpenAI round-trip.
    background_tasks.add_task(regenerate_task_embedding, task_id, user_id)
    # Schedule this task's reminders. Off-thread for the same reason: the
    # user is waiting on a bubble appearing, not on three rows of INSERT.
    background_tasks.add_task(sync_task_plans, row, user_id)
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

    # Replan unconditionally rather than testing which fields moved. Every
    # one of due_at, importance, status and parent_cluster_id changes the
    # schedule, that is most of what PATCH is used for, and a missed replan
    # is a reminder that fires for a deadline the user already moved.
    background_tasks.add_task(sync_task_plans, row, user_id)

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

    # Awaited, not backgrounded: being reminded about something you just
    # deleted is the single worst failure this feature has, and it is worth
    # one indexed UPDATE on the response path to make it impossible.
    await notifications_db.cancel_pending_for_task(task_id)


# ---------------------------------------------------------------------------
# Voice-driven update — parse a spoken instruction into a field-level patch
# ---------------------------------------------------------------------------

class VoiceUpdateRequest(BaseModel):
    transcript: str
    user_timezone: Optional[str] = None
    # BCP-47 tag. Optional — falls back to the stored preference, then to
    # English, exactly as the draft path and the chat router do.
    language: Optional[str] = None


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

    # Without this the Portuguese time patterns never run on this path —
    # parse_voice_update defaulted language to None, is_portuguese(None)
    # is False, and "às oito da noite" fell through to the English
    # patterns, which read it as 08:00. The draft path already did this;
    # only the edit-an-existing-task path was missing it.
    language = body.language
    if not language:
        try:
            prefs = await users_db.fetch_preferences(user_id)
            language = (prefs or {}).get("language")
        except Exception as exc:  # noqa: BLE001 — never block the edit
            logger.warning("Could not read language preference: %s", exc)
            language = None

    try:
        result = await parse_voice_update(
            current_task=task,
            user_message=body.transcript,
            user_id=user_id,
            user_tier=user_tier,
            user_timezone=body.user_timezone,
            language=language,
        )
    except AIRateLimited as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_error(str(exc), "AI_RATE_LIMITED"),
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

    try:
        result = await parse_voice_update(
            current_task=body.draft.model_dump(mode="json"),
            user_message=body.transcript,
            user_id=user_id,
            user_tier=user_tier,
            user_timezone=body.user_timezone,
            language=language,
        )
    except AIRateLimited as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_error(str(exc), "AI_RATE_LIMITED"),
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
