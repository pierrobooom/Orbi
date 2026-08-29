from datetime import datetime, time
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, EmailStr


class SubscriptionTier(str, Enum):
    free = "free"
    pro = "pro"
    premium = "premium"


class UserProfile(BaseModel):
    id: UUID
    email: EmailStr
    full_name: str
    subscription_tier: SubscriptionTier
    created_at: datetime
    updated_at: datetime


class UsageMeter(BaseModel):
    used: int
    cap: int


class UsageResets(BaseModel):
    daily: datetime
    monthly: datetime


class UsageSnapshot(BaseModel):
    """A point-in-time snapshot of the user's quota consumption."""
    tier: SubscriptionTier
    daily: dict[str, UsageMeter]
    monthly: dict[str, UsageMeter]
    resets: UsageResets


class UserPreference(BaseModel):
    user_id: UUID
    quiet_hours_start: time
    quiet_hours_end: time
    # 1 = minimal interruptions, 5 = highly proactive
    proactivity_level: int
    preferred_reminder_channel: str
    # BCP-47 tag. Drives speech-to-text language, the language the agents
    # reply in, and which locale pack the sanitizer / time extractor use.
    language: str = "en-GB"
    # BCP-47 tag. Drives speech-to-text language, the language the agents
    # reply in, and which locale pack the sanitizer / time extractor use.
    language: str = "en-GB"

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "user_id": "00000000-0000-0000-0000-000000000001",
                    "quiet_hours_start": "22:00",
                    "quiet_hours_end": "08:00",
                    "proactivity_level": 3,
                    "preferred_reminder_channel": "push",
                }
            ]
        }
    }
