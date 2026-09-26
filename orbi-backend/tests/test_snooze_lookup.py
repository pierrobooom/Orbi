"""Snoozing a reminder must find it however much history the user has.

The regression: the endpoint searched the user's 200 earliest plans for the
one tapped. Sent and cancelled rows are kept, so once a user passed 200 rows
the newest reminder — a chase, always the latest — was never in the page.
"Snooze 1h" returned 404, the task kept its old deadline and stayed red.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers import notifications as router

USER = uuid4()
TASK_ID = str(uuid4())
PLAN_ID = uuid4()


def _task() -> dict:
    now = datetime.now(timezone.utc)
    return {
        "id": TASK_ID,
        "owner_id": str(USER),
        "title": "Inscrever no ginásio",
        "status": "active",
        "importance": 5,
        "urgency_score": 0.5,
        "pressure_score": 0.9,
        "source_type": "text",
        "confidence": 1.0,
        "due_at": (now - timedelta(hours=2)).isoformat(),
        "created_at": (now - timedelta(days=1)).isoformat(),
        "updated_at": (now - timedelta(hours=3)).isoformat(),
    }


@pytest.fixture
def wired(monkeypatch):
    """The router with its database calls replaced, recording the task update."""
    calls: dict = {}

    async def fetch_owned(plan_id, owner_id):
        if str(plan_id) == str(PLAN_ID) and str(owner_id) == str(USER):
            return {"id": str(PLAN_ID), "task_id": TASK_ID, "kind": "chase",
                    "trigger_at": datetime.now(timezone.utc).isoformat(),
                    "state": "sent", "snooze_count": 0, "sent_at": None}
        return None

    async def fetch_task_by_id(task_id, owner_id):
        return _task()

    async def update_task(task_id, owner_id, fields):
        calls["update"] = fields
        return {**_task(), **fields}

    async def sync_task_plans(task, owner_id):
        calls["synced"] = True

    async def fetch_pending_for_task(task_id):
        return []

    async def mark_state(ids, state):
        calls["marked"] = (ids, state)

    monkeypatch.setattr(router.notifications_db, "fetch_owned", fetch_owned)
    monkeypatch.setattr(router.notifications_db, "fetch_pending_for_task", fetch_pending_for_task)
    monkeypatch.setattr(router.notifications_db, "mark_state", mark_state)
    monkeypatch.setattr(router.tasks_db, "fetch_task_by_id", fetch_task_by_id)
    monkeypatch.setattr(router.tasks_db, "update_task", update_task)
    monkeypatch.setattr(router.reminder_dispatcher, "sync_task_plans", sync_task_plans)
    return calls


@pytest.mark.asyncio
async def test_snooze_moves_the_task_even_past_a_page_of_history(wired):
    before = datetime.now(timezone.utc)
    await router.snooze_plan(PLAN_ID, router.SnoozeRequest(minutes=60), user_id=USER)

    new_due = datetime.fromisoformat(wired["update"]["due_at"])
    assert new_due >= before + timedelta(minutes=59)
    assert wired.get("synced")


@pytest.mark.asyncio
async def test_someone_elses_reminder_is_not_found(wired):
    with pytest.raises(HTTPException) as caught:
        await router.snooze_plan(PLAN_ID, router.SnoozeRequest(minutes=60), user_id=uuid4())
    assert caught.value.status_code == 404
    assert "update" not in wired


@pytest.mark.asyncio
async def test_answering_finds_the_reminder_past_a_page_of_history(wired, monkeypatch):
    async def fetch_one(plan_id):
        return {"id": str(plan_id), "task_id": TASK_ID, "kind": "chase",
                "trigger_at": datetime.now(timezone.utc).isoformat(),
                "state": "answered", "snooze_count": 0, "sent_at": None}

    monkeypatch.setattr(router.notifications_db, "fetch_one", fetch_one)
    result = await router.mark_plan_answered(PLAN_ID, user_id=USER)
    assert result["state"] == "answered"
    assert wired["marked"] == ([str(PLAN_ID)], "answered")


# ---------------------------------------------------------------------------
# The list: what's coming, then what happened
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_list_shows_upcoming_first_then_recent_history(monkeypatch):
    """It used to return the 100 earliest plans by trigger_at — the oldest
    history, and none of the reminders actually coming up."""
    upcoming = [{"id": str(uuid4()), "task_id": TASK_ID, "kind": "due",
                 "trigger_at": "2026-09-27T08:00:00+00:00", "state": "pending",
                 "snooze_count": 0, "sent_at": None}]
    history = [{"id": str(uuid4()), "task_id": TASK_ID, "kind": "chase",
                "trigger_at": "2026-09-26T08:00:00+00:00", "state": "skipped",
                "snooze_count": 0, "sent_at": None}]
    calls = {}

    async def fetch_upcoming(owner_id, limit=50):
        calls["upcoming"] = owner_id
        return upcoming

    async def fetch_recent_history(owner_id, limit=50):
        calls["history"] = owner_id
        return history

    async def preferences_for(owner_id):
        return {"proactivity_level": 5}

    monkeypatch.setattr(router.notifications_db, "fetch_upcoming", fetch_upcoming)
    monkeypatch.setattr(router.notifications_db, "fetch_recent_history", fetch_recent_history)
    monkeypatch.setattr(router.reminder_dispatcher, "preferences_for", preferences_for)

    result = await router.list_my_plans(user_id=USER)
    assert [p.state for p in result.plans] == ["pending", "skipped"]
    assert calls == {"upcoming": USER, "history": USER}
