"""Database queries for notification_plans.

All functions interact directly with Supabase. No business logic lives here —
when a reminder should fire is decided in services/reminder_schedule.py, and
whether it actually goes out is decided in services/reminder_dispatcher.py.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID

from app.db.client import get_client

logger = logging.getLogger(__name__)

# Everything the dispatcher needs to write a notification, fetched in one
# round trip via the task_id foreign key. Deliberately excludes the task's
# embedding column, which serialises to ~12KB per row and would dominate
# the response for data the dispatcher never reads.
_DUE_SELECT = (
    "id,owner_id,task_id,kind,trigger_at,snooze_count,"
    "task_bubbles(id,title,due_at,importance,pressure_score,status,parent_cluster_id)"
)

_LIVE_STATE = "pending"


async def fetch_pending_for_task(task_id: UUID) -> list[dict]:
    """Return the still-scheduled plans for one task."""
    response = (
        get_client().table("notification_plans")
        .select("id,kind,trigger_at,snooze_count")
        .eq("task_id", str(task_id))
        .eq("state", _LIVE_STATE)
        .execute()
    )
    return response.data or []


async def cancel_pending_for_task(task_id: UUID) -> int:
    """Cancel every scheduled plan for a task. Returns how many were cancelled.

    Cancels rather than deletes so "we scheduled this and then the task
    changed" stays visible when someone asks why a reminder never arrived.
    """
    response = (
        get_client().table("notification_plans")
        .update({"state": "cancelled", "updated_at": _now_iso()})
        .eq("task_id", str(task_id))
        .eq("state", _LIVE_STATE)
        .execute()
    )
    return len(response.data or [])


async def cancel_pending_for_cluster(owner_id: UUID, cluster_id: UUID) -> int:
    """Cancel scheduled plans for every task in a cluster.

    Two queries rather than one: PostgREST cannot filter a table by a column
    on an embedded resource, so the task ids are resolved first. Muting a
    cluster is rare and interactive, so the extra round trip is free.
    """
    tasks = (
        get_client().table("task_bubbles")
        .select("id")
        .eq("owner_id", str(owner_id))
        .eq("parent_cluster_id", str(cluster_id))
        .execute()
    )
    task_ids = [row["id"] for row in (tasks.data or [])]
    if not task_ids:
        return 0

    response = (
        get_client().table("notification_plans")
        .update({"state": "cancelled", "updated_at": _now_iso()})
        .in_("task_id", task_ids)
        .eq("state", _LIVE_STATE)
        .execute()
    )
    return len(response.data or [])


async def insert_plans(rows: list[dict]) -> list[dict]:
    """Insert scheduled plans. No-op on an empty list.

    Callers must have cancelled any conflicting pending rows first — the
    partial unique index on (task_id, kind) WHERE state = 'pending' will
    reject a duplicate rather than silently creating a second reminder.
    """
    if not rows:
        return []
    response = get_client().table("notification_plans").insert(rows).execute()
    return response.data or []


async def fetch_due_plans(now: datetime, limit: int = 200) -> list[dict]:
    """Return plans whose time has come, oldest first.

    Ordered by trigger_at so a backlog after downtime drains in the order it
    was meant to fire, not in whatever order Postgres felt like returning.
    """
    response = (
        get_client().table("notification_plans")
        .select(_DUE_SELECT)
        .eq("state", _LIVE_STATE)
        .lte("trigger_at", now.isoformat())
        .order("trigger_at")
        .limit(limit)
        .execute()
    )
    return response.data or []


async def count_sent_since(owner_id: UUID, since: datetime) -> int:
    """How many notifications this user has already been sent since `since`.

    This is the daily budget's meter. Counts sent rows only — a plan skipped
    for budget did not interrupt anyone and must not consume a slot.
    """
    response = (
        get_client().table("notification_plans")
        .select("id", count="exact")
        .eq("owner_id", str(owner_id))
        .eq("state", "sent")
        .gte("sent_at", since.isoformat())
        .execute()
    )
    return response.count or 0


async def mark_state(plan_ids: list[str], state: str) -> int:
    """Move a batch of plans to a terminal state. Returns rows updated."""
    if not plan_ids:
        return 0
    payload: dict = {"state": state, "updated_at": _now_iso()}
    if state == "sent":
        payload["sent_at"] = _now_iso()
    elif state == "answered":
        payload["answered_at"] = _now_iso()

    response = (
        get_client().table("notification_plans")
        .update(payload)
        .in_("id", plan_ids)
        .execute()
    )
    return len(response.data or [])


async def fetch_for_user(
    owner_id: UUID, states: list[str] | None = None, limit: int = 100
) -> list[dict]:
    """Return this user's plans, soonest first. Powers the preview endpoint."""
    query = (
        get_client().table("notification_plans")
        .select("id,task_id,kind,trigger_at,state,snooze_count,sent_at")
        .eq("owner_id", str(owner_id))
    )
    if states:
        query = query.in_("state", states)
    response = query.order("trigger_at").limit(limit).execute()
    return response.data or []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def postpone_plans(plan_ids: list[str], trigger_at: datetime) -> int:
    """Move plans to a later time without consuming or cancelling them.

    Used when a plan comes due inside quiet hours — the reminder is still
    owed, just not at 03:00.
    """
    if not plan_ids:
        return 0
    response = (
        get_client().table("notification_plans")
        .update({"trigger_at": trigger_at.isoformat(), "updated_at": _now_iso()})
        .in_("id", plan_ids)
        .execute()
    )
    return len(response.data or [])


async def fetch_one(plan_id: UUID) -> dict | None:
    """Return a single plan, or None. Ownership is checked by the caller."""
    response = (
        get_client().table("notification_plans")
        .select("id,task_id,kind,trigger_at,state,snooze_count,sent_at")
        .eq("id", str(plan_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def fetch_owned(plan_id: UUID, owner_id: UUID) -> dict | None:
    """Return one plan if it belongs to this user, else None.

    Looked up by id, not by searching a page of the user's plans. Sent and
    cancelled rows are kept as history, so a page of the earliest N stops
    containing the newest reminder once a user has more than N rows — and
    the newest reminder is exactly the one a button press is about.
    """
    response = (
        get_client().table("notification_plans")
        .select("id,task_id,kind,trigger_at,state,snooze_count,sent_at")
        .eq("id", str(plan_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


async def snooze(plan_id: UUID, trigger_at: datetime, snooze_count: int) -> dict:
    """Re-arm a plan at a later time and record the snooze.

    Resets state to pending so an already-sent reminder becomes schedulable
    again — a snooze is a request to be told once more, which is exactly
    what a pending plan is.
    """
    response = (
        get_client().table("notification_plans")
        .update(
            {
                "state": _LIVE_STATE,
                "trigger_at": trigger_at.isoformat(),
                "snooze_count": snooze_count,
                "sent_at": None,
                "updated_at": _now_iso(),
            }
        )
        .eq("id", str(plan_id))
        .execute()
    )
    return response.data[0]
