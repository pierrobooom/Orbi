"""Clusters router — CRUD endpoints for task Clusters.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

from app.agents.cluster_manager import propose_organisation
from app.db import clusters as clusters_db, tasks as tasks_db
from app.models.task import Cluster
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.cluster_apply import apply_organisation

router = APIRouter(prefix="/clusters", tags=["clusters"])


class ClusterCreate(BaseModel):
    name: str
    summary: Optional[str] = None
    color: str = "#7C6FE0"
    parent_cluster_id: Optional[UUID] = None


class ClusterUpdate(BaseModel):
    name: Optional[str] = None
    summary: Optional[str] = None
    color: Optional[str] = None
    parent_cluster_id: Optional[UUID] = None


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


@router.get("", response_model=list[Cluster])
async def list_clusters(user_id: UUID = Depends(get_current_user)):
    """Return all clusters for the authenticated user, ordered by weight_score desc."""
    return await clusters_db.fetch_clusters_for_user(user_id)


@router.post("", response_model=Cluster, status_code=status.HTTP_201_CREATED)
async def create_cluster(
    body: ClusterCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create a new cluster."""
    now = datetime.now(timezone.utc)
    payload = {
        "id": str(uuid4()),
        "owner_id": str(user_id),
        "name": body.name,
        "summary": body.summary,
        "color": body.color,
        "weight_score": 0.0,
        "active_count": 0,
        "parent_cluster_id": str(body.parent_cluster_id) if body.parent_cluster_id else None,
        "created_at": now.isoformat(),
    }
    row = await clusters_db.insert_cluster(payload)
    return row


# ---------------------------------------------------------------------------
# Auto-organisation — LLM-driven proposal / apply pair
#
# These static-path POSTs MUST be declared before the /{cluster_id}
# routes below. FastAPI matches routes in registration order; a path
# like /clusters/auto-organize would otherwise be captured by the
# /{cluster_id} pattern (which only registers GET/PATCH/DELETE) and the
# server would return 405 Method Not Allowed instead of routing here.
# ---------------------------------------------------------------------------

class ProposalAction(BaseModel):
    """A single reorganisation action. Shape varies by `type`; the
    cluster_manager agent validates the structure per type already, so
    this is just a permissive carrier the mobile can echo back."""

    type: str
    name: Optional[str] = None
    color: Optional[str] = None
    new_name: Optional[str] = None
    cluster_id: Optional[UUID] = None
    source_id: Optional[UUID] = None
    target_id: Optional[UUID] = None
    task_ids: list[UUID] = []
    reason: Optional[str] = None


class ProposalResponse(BaseModel):
    actions: list[ProposalAction]


class ApplyRequest(BaseModel):
    actions: list[ProposalAction]


class ApplyResponse(BaseModel):
    # Counts per action type, plus a list of any actions that were
    # skipped during validation. Mobile uses this for the toast and to
    # decide whether to refetch the universe.
    applied: dict[str, int]
    skipped: list[dict]


@router.post("/auto-organize", response_model=ProposalResponse)
async def auto_organize(auth: dict = Depends(get_current_user_with_tier)):
    """Generate a reorganisation proposal for the caller's universe.

    Read-only. The mobile reviews each action with a checkbox and only
    approved actions reach /apply-organisation. We send the full
    cluster + task state to the LLM each call; this is one AI turn
    against the daily cap.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    cluster_rows = await clusters_db.fetch_clusters_for_user(user_id)
    task_rows = await tasks_db.fetch_tasks_for_user(user_id)

    # Trim each row to just the fields the agent needs. Saves tokens
    # and avoids leaking timestamps / scores into the prompt context.
    cluster_payload = [
        {
            "id": str(c["id"]),
            "name": c.get("name"),
            "task_count": sum(
                1 for t in task_rows
                if str(t.get("parent_cluster_id") or "") == str(c["id"])
            ),
        }
        for c in cluster_rows
    ]
    task_payload = [
        {
            "id": str(t["id"]),
            "title": t.get("title"),
            "label": t.get("label"),
            "domain_hint": t.get("domain_hint"),
            "parent_cluster_id": str(t["parent_cluster_id"]) if t.get("parent_cluster_id") else None,
        }
        for t in task_rows
    ]

    result = await propose_organisation(
        clusters=cluster_payload,
        tasks=task_payload,
        user_id=user_id,
        user_tier=user_tier,
    )
    return ProposalResponse(**result)


@router.post("/apply-organisation", response_model=ApplyResponse)
async def apply_organisation_route(
    body: ApplyRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Apply the subset of proposal actions the user approved.

    Server re-validates every id against the caller's data. Actions
    that fail validation are silently skipped and surfaced in the
    response's `skipped` list. The mobile refetches clusters + tasks
    after this to redraw the canvas.
    """
    # Convert ProposalAction models back to plain dicts for the apply
    # service — the service treats them as best-effort dicts so the
    # shape stays loose and forward-compatible.
    raw_actions = [a.model_dump(mode="json", exclude_none=False) for a in body.actions]
    summary = await apply_organisation(raw_actions, user_id)
    return ApplyResponse(**summary)


# ---------------------------------------------------------------------------
# Path-parameter routes — declared AFTER the static auto-organisation
# paths so the /clusters/auto-organize POST isn't shadowed by /{cluster_id}.
# ---------------------------------------------------------------------------


@router.get("/{cluster_id}", response_model=Cluster)
async def get_cluster(cluster_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Fetch a single cluster by ID."""
    row = await clusters_db.fetch_cluster_by_id(cluster_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Cluster not found.", "CLUSTER_NOT_FOUND"),
        )
    return row


@router.patch("/{cluster_id}", response_model=Cluster)
async def update_cluster(
    cluster_id: UUID,
    body: ClusterUpdate,
    user_id: UUID = Depends(get_current_user),
):
    """Partially update a cluster."""
    existing = await clusters_db.fetch_cluster_by_id(cluster_id, user_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Cluster not found.", "CLUSTER_NOT_FOUND"),
        )

    update_payload = body.model_dump(exclude_none=True, mode="json")
    if not update_payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("No fields to update.", "NO_UPDATABLE_FIELDS"),
        )

    row = await clusters_db.update_cluster(cluster_id, user_id, update_payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Cluster not found.", "CLUSTER_NOT_FOUND"),
        )
    return row


@router.delete("/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cluster(cluster_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Delete a cluster. Tasks in this cluster will become unassigned."""
    success = await clusters_db.delete_cluster(cluster_id, user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Cluster not found.", "CLUSTER_NOT_FOUND"),
        )
