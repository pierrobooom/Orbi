from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class ConversationSource(str, Enum):
    voice = "voice"
    text = "text"


class ConversationEvent(BaseModel):
    id: UUID
    user_id: UUID
    session_id: UUID
    role: str  # "user" or "assistant"
    content: str
    source: ConversationSource
    intent: Optional[str] = None
    agent_used: Optional[str] = None
    tokens_used: Optional[int] = None
    created_at: datetime


class ConversationEventCreate(BaseModel):
    session_id: UUID
    role: str
    content: str
    source: ConversationSource = ConversationSource.text
    intent: Optional[str] = None
    agent_used: Optional[str] = None
    tokens_used: Optional[int] = None
