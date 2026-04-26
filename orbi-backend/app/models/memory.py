from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class MemoryType(str, Enum):
    fact = "fact"
    decision = "decision"
    pattern = "pattern"
    summary = "summary"


class MemoryNode(BaseModel):
    id: UUID
    user_id: UUID
    content: str
    memory_type: MemoryType
    tags: list[str] = Field(default_factory=list)
    importance: int = Field(ge=1, le=10)
    source_summary: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class MemoryNodeCreate(BaseModel):
    content: str
    memory_type: MemoryType
    tags: list[str] = Field(default_factory=list)
    importance: int = Field(default=5, ge=1, le=10)
    source_summary: Optional[str] = None
