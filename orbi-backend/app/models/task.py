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
    visibility: Visibility = Visibility.private
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


class Cluster(BaseModel):
    id: UUID
    owner_id: UUID
    name: str
    summary: Optional[str] = None
    color: str
    weight_score: float
    active_count: int
    parent_cluster_id: Optional[UUID] = None
    created_at: datetime
