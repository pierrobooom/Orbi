"""Notifications router — reminder schedule inspection and dispatch.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import hmac
import logging
import os
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.db import notifications as notifications_db
from app.models.notification import (
    DispatchResponse,
    NotificationPlan,
    NotificationPlanList,
    ResyncResponse,
    SnoozeRequest,
)
from app.services.auth import get_current_user
from app.services.reminder_dispatcher import dispatch_due, resync_user_plans
from app.services.reminder_schedule import daily_budget
from app.services import reminder_dispatcher

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])

_DISPATCH_SECRET_ENV = "NOTIFICATIONS_DISPATCH_SECRET"


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


@router.get("/plans", response_model=NotificationPlanList)
async def list_my_plans(user_id: UUID = Depends(get_current_user)):
    """Return the caller's upcoming and recently sent reminders.

    Exists so "why didn't I get a reminder?" has an answer that isn't a
    shrug. A skipped plan in the list, next to the daily budget it lost to,
    explains itself.
    """
    rows = await notifications_db.fetch_for_user(user_id, limit=100)
    prefs = await reminder_dispatcher.preferences_for(user_id)
    return NotificationPlanList(
        plans=rows,
        daily_budget=daily_budget(prefs.get("proactivity_level")),
    )


@router.post("/resync", response_model=ResyncResponse)
async def resync_my_plans(user_id: UUID = Depends(get_current_user)):
    """Recompute every reminder for the caller's active tasks.

    Needed whenever something global changes the schedule rather than a
    single task: quiet hours, timezone, the reminder toggles. Cheap enough
    to call on any preference save — a user has tens of active tasks, not
    thousands, and each one is three rows of arithmetic.
    """
    considered, scheduled = await resync_user_plans(user_id)
    return ResyncResponse(tasks_considered=considered, plans_scheduled=scheduled)


@router.post("/{plan_id}/snooze", response_model=NotificationPlan)
async def snooze_plan(
    plan_id: UUID,
    body: SnoozeRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Push one reminder back and let it fire again.

    Snoozing re-arms the plan rather than creating a new one, so snooze_count
    keeps climbing on the same row. That count is the honest signal that a
    task is being avoided rather than done, and it is lost the moment each
    snooze becomes a fresh record.
    """
    rows = await notifications_db.fetch_for_user(user_id, limit=200)
    plan = next((r for r in rows if str(r["id"]) == str(plan_id)), None)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Reminder not found.", "PLAN_NOT_FOUND"),
        )

    updated = await notifications_db.snooze(
        plan_id,
        trigger_at=datetime.now(timezone.utc) + timedelta(minutes=body.minutes),
        snooze_count=int(plan.get("snooze_count") or 0) + 1,
    )
    return updated


@router.post("/{plan_id}/answered", response_model=NotificationPlan)
async def mark_plan_answered(
    plan_id: UUID,
    user_id: UUID = Depends(get_current_user),
):
    """Record that the user acted on a reminder.

    Separate from completing the task: answering a chase with "not yet, but
    I've seen it" is information, and it stops the escalation without
    claiming the work is done.
    """
    rows = await notifications_db.fetch_for_user(user_id, limit=200)
    if not any(str(r["id"]) == str(plan_id) for r in rows):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Reminder not found.", "PLAN_NOT_FOUND"),
        )

    await notifications_db.mark_state([str(plan_id)], "answered")
    updated = await notifications_db.fetch_one(plan_id)
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Reminder not found.", "PLAN_NOT_FOUND"),
        )
    return updated


@router.post("/dispatch", response_model=DispatchResponse)
async def dispatch(x_dispatch_secret: str | None = Header(default=None)):
    """Send every reminder that is due. For an external scheduler, not clients.

    The in-process loop in main.py covers the single-instance case. This
    endpoint is the seam for the multi-instance one — a cron, a Supabase
    pg_cron job, or a platform scheduler — where running the loop in every
    replica would send every reminder as many times as there are replicas.

    Guarded by a shared secret rather than user auth because there is no user
    behind a cron. Unset secret means the endpoint is off: an internal
    endpoint that silently defaults to open is worse than one that isn't
    there.
    """
    expected = os.environ.get(_DISPATCH_SECRET_ENV, "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "External dispatch is not configured.",
                "DISPATCH_NOT_CONFIGURED",
            ),
        )
    # compare_digest rather than ==: a plain comparison returns as soon as
    # two bytes differ, which leaks the secret one character at a time to
    # anyone willing to time a few thousand requests.
    if not hmac.compare_digest(x_dispatch_secret or "", expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_error("Invalid dispatch secret.", "DISPATCH_UNAUTHORIZED"),
        )

    result = await dispatch_due()
    return DispatchResponse(**result)
