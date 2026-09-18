from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class NotificationKind(str, Enum):
    """What a reminder is for. See services/reminder_schedule.py for timing."""

    lead = "lead"
    due = "due"
    chase = "chase"
    escalate = "escalate"


class NotificationState(str, Enum):
    pending = "pending"
    sent = "sent"
    answered = "answered"
    cancelled = "cancelled"
    skipped = "skipped"


class NotificationPlan(BaseModel):
    id: UUID
    task_id: UUID
    kind: NotificationKind
    trigger_at: datetime
    state: NotificationState
    snooze_count: int = 0
    sent_at: Optional[datetime] = None


class NotificationPlanList(BaseModel):
    plans: list[NotificationPlan]
    # The user's current ceiling, so the client can explain a silence
    # ("you're set to 2 a day and 5 things were due") instead of looking
    # broken.
    daily_budget: int


class ResyncResponse(BaseModel):
    """Result of recomputing every plan for the caller's tasks."""

    tasks_considered: int
    plans_scheduled: int


class DispatchResponse(BaseModel):
    considered: int
    sent: int
    skipped: int
    postponed: int


class SnoozeRequest(BaseModel):
    """How far to push a reminder back.

    Bounded at a week: beyond that the user is not snoozing, they are
    rescheduling the task, and doing that through the reminder leaves the
    task's own due date lying about when it is needed.
    """

    minutes: int = Field(default=60, ge=5, le=10080)
