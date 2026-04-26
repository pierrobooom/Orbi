"""Clusters router — CRUD endpoints for task Clusters.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

from app.db import clusters as clusters_db
from app.models.task import Cluster
from app.services.auth import get_current_user

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
