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

from app.db import notifications as notifications_db, tasks as tasks_db
from app.models.notification import (
    DispatchResponse,
    NotificationPlan,
    NotificationPlanList,
    ResyncResponse,
    SnoozeRequest,
)
from app.services.auth import get_current_user
from app.services.reminder_dispatcher import dispatch_due, resync_user_plans
from app.models.task import TaskBubble
from app.services.reminder_schedule import daily_budget
from app.services.scoring import calculate_pressure_score
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
    # Upcoming first, then what already happened, newest first. This used to
    # be one query for the 100 earliest plans by trigger_at — the oldest
    # history, and never the reminders coming up once a user had more than
    # 100 rows. The two ends of the question are two queries.
    upcoming = await notifications_db.fetch_upcoming(user_id)
    history = await notifications_db.fetch_recent_history(user_id)
    rows = upcoming + history
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
    """Postpone the TASK, not just the reminder.

    This used to re-arm the notification and leave the task alone, which made
    the app contradict itself: a task postponed to tomorrow still showed a
    deadline of today, still scored 10/10 pressure, and still rendered as a
    huge red bubble screaming that it was overdue. Pressure is derived from
    due_at (services/scoring.py), so the only way "postpone" can mean anything
    is to move due_at.

    So a snooze now:
      1. moves the task's deadline to the new time,
      2. recalculates pressure, which shrinks the bubble,
      3. and replans every reminder from the new deadline.

    Step 3 supersedes re-arming this particular row: the plans are rebuilt
    relative to the new due_at, so the "due" reminder lands when the task is
    actually due rather than at an arbitrary offset from when the button was
    pressed.

    snooze_count still climbs on the task's live plan, because "this has been
    pushed back six times" is the honest signal that something is being
    avoided rather than done.
    """
    # By id, owner-scoped. This searched the user's 200 earliest plans, and
    # history rows are never pruned, so past 200 rows the newest reminder —
    # the one just tapped — was never in the page: "Snooze 1h" on a chase
    # returned 404 and the task stayed red.
    plan = await notifications_db.fetch_owned(plan_id, user_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Reminder not found.", "PLAN_NOT_FOUND"),
        )

    task = await tasks_db.fetch_task_by_id(UUID(str(plan["task_id"])), user_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Task not found.", "TASK_NOT_FOUND"),
        )

    new_due = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
    merged = TaskBubble(**{**task, "due_at": new_due})

    updated_task = await tasks_db.update_task(
        UUID(str(task["id"])),
        user_id,
        {
            "due_at": new_due.isoformat(),
            "pressure_score": calculate_pressure_score(merged),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )

    previous_snoozes = int(plan.get("snooze_count") or 0) + 1
    await reminder_dispatcher.sync_task_plans(updated_task or task, user_id)

    # Carry the count onto whichever plan now represents this task, so it
    # survives the replan rather than resetting every time.
    live = await notifications_db.fetch_pending_for_task(UUID(str(task["id"])))
    if live:
        return await notifications_db.snooze(
            UUID(str(live[0]["id"])),
            trigger_at=_parse_trigger(live[0]["trigger_at"]),
            snooze_count=previous_snoozes,
        )

    # No reminder survives — the new deadline is far enough out, or reminders
    # are off. The task still moved, which was the point.
    await notifications_db.mark_state([str(plan_id)], "answered")
    return {**plan, "state": "answered", "snooze_count": previous_snoozes}


def _parse_trigger(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


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
    if await notifications_db.fetch_owned(plan_id, user_id) is None:
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
