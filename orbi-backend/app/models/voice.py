from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class VoiceSessionStatus(str, Enum):
    active = "active"
    completed = "completed"
    abandoned = "abandoned"


class VoiceSessionKind(str, Enum):
    debrief = "debrief"
    capture = "capture"
    query = "query"


class VoiceSession(BaseModel):
    id: UUID
    user_id: UUID
    conversation_session_id: UUID
    kind: VoiceSessionKind
    status: VoiceSessionStatus
    topic: Optional[str] = None
    started_at: datetime
    ended_at: Optional[datetime] = None
    extraction: Optional[dict] = None
    duration_seconds: Optional[float] = None


class VoiceSessionStart(BaseModel):
    kind: VoiceSessionKind = VoiceSessionKind.debrief
    topic: Optional[str] = Field(
        default=None,
        description="Optional context, e.g. 'Q2 planning meeting with Alex'",
    )


class TranscriptionResult(BaseModel):
    transcript: str
    confidence: float
    duration_seconds: float
    provider: str
    model: str


class VoiceTurnRequest(BaseModel):
    voice_session_id: UUID
    user_message: str = Field(..., description="Transcribed user speech")


class VoiceTurnResponse(BaseModel):
    voice_session_id: UUID
    conversation_session_id: UUID
    reply: str
    is_complete: bool
    extraction: Optional[dict] = None


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: Optional[str] = None
