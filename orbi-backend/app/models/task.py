from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    active = "active"
    completed = "completed"
    snoozed = "snoozed"
    archived = "archived"


class Visibility(str, Enum):
    private = "private"
    shared = "shared"
    collaborative = "collaborative"


class TaskBubble(BaseModel):
    id: UUID
    owner_id: UUID
    title: str
    # Short keyword shown inside the bubble visualisation. Nullable so
    # tasks created before the 0005 migration keep working; the client
    # falls back to client-side title shortening when label is None.
    label: Optional[str] = None
    description: Optional[str] = None
    status: TaskStatus
    # Set when status transitions into 'completed', cleared on the way
    # out. Distinct from updated_at, which moves on any edit — see
    # migration 0010.
    completed_at: Optional[datetime] = None
    due_at: Optional[datetime] = None
    importance: int = Field(ge=1, le=10)
    urgency_score: float
    pressure_score: float
    domain_hint: Optional[str] = None
    parent_cluster_id: Optional[UUID] = None
    # how the bubble was created, e.g. "voice", "manual", "import"
    source_type: str
    # AI confidence in parsed fields (0.0–1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    # Where the user dropped this bubble, as a 0..1 fraction of the canvas.
    # None means they never moved it and the layout pass still owns it —
    # which is a different thing from 0, and why these are nullable rather
    # than defaulted.
    canvas_x: Optional[float] = None
    canvas_y: Optional[float] = None
    visibility: Visibility = Visibility.private
    # Set only on tasks reaching this user through a share. The client uses
    # them to render somebody else's task as joint work rather than as one
    # of their own — a shared bubble that looks identical to an owned one is
    # a bubble people delete by accident.
    shared_with_me: Optional[bool] = None
    shared_by_user_id: Optional[UUID] = None
    i_completed_at: Optional[datetime] = None
    owner_completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class TaskBubbleCreate(BaseModel):
    owner_id: UUID
    title: str
    label: Optional[str] = None
    description: Optional[str] = None
    status: TaskStatus = TaskStatus.active
    due_at: Optional[datetime] = None
    importance: int = Field(default=5, ge=1, le=10)
    urgency_score: float = 0.0
    pressure_score: float = 0.0
    domain_hint: Optional[str] = None
    parent_cluster_id: Optional[UUID] = None
    source_type: str = "manual"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    visibility: Visibility = Visibility.private


class TaskBubbleUpdate(BaseModel):
    title: Optional[str] = None
    label: Optional[str] = None
    description: Optional[str] = None
    status: Optional[TaskStatus] = None
    due_at: Optional[datetime] = None
    importance: Optional[int] = Field(default=None, ge=1, le=10)
    urgency_score: Optional[float] = None
    pressure_score: Optional[float] = None
    domain_hint: Optional[str] = None
    parent_cluster_id: Optional[UUID] = None
    source_type: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    visibility: Optional[Visibility] = None
    # Clamped rather than merely validated: a gesture that ends slightly
    # off-canvas should place the bubble at the edge, not fail the save and
    # lose the placement.
    canvas_x: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    canvas_y: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class Cluster(BaseModel):
    id: UUID
    owner_id: UUID
    name: str
    summary: Optional[str] = None
    color: str
    # Canvas placement/palette anchor. Assigned once at creation and never
    # re-derived from the name — see services/cluster_kind.py for why.
    kind: str = "drift"
    weight_score: float
    active_count: int
    parent_cluster_id: Optional[UUID] = None
    # Same as TaskBubble: None means the weight-based layout still owns it.
    canvas_x: Optional[float] = None
    canvas_y: Optional[float] = None
    created_at: datetime
