"""Reliability of the reminder pipeline: dispatch, snooze, replanning.

Each test here pins a failure found in review, stated in its docstring. The
database and Expo are replaced with in-memory fakes, so these exercise the
real decision logic without touching the network.
"""

from datetime import datetime, time, timedelta, timezone
from uuid import uuid4

import pytest

from app.routers import notifications as router
from app.services import reminder_dispatcher as dispatcher
from app.services.reminder_schedule import plan_for_task

UTC = timezone.utc
# 10:00 in Lisbon (UTC+1): outside the quiet window below.
NOW = datetime(2026, 9, 26, 9, 0, tzinfo=UTC)
OWNER = uuid4()
PREFS = {
    **dispatcher._DEFAULT_PREFERENCES,
    "timezone": "Europe/Lisbon",
    "quiet_hours_start": "00:00:00",
    "quiet_hours_end": "07:00:00",
    "proactivity_level": 5,
}


def _task(task_id: str, **fields) -> dict:
    return {
        "id": task_id,
        "owner_id": str(OWNER),
        "title": "Pagar a água",
        "status": "active",
        "importance": 5,
        "urgency_score": 0.5,
        "pressure_score": 0.5,
        "source_type": "text",
        "confidence": 1.0,
        "parent_cluster_id": None,
        "due_at": (NOW - timedelta(hours=3)).isoformat(),
        "created_at": (NOW - timedelta(days=1)).isoformat(),
        "updated_at": (NOW - timedelta(days=1)).isoformat(),
        **fields,
    }


def _plan(task: dict, kind: str, trigger_at: datetime) -> dict:
    return {
        "id": str(uuid4()),
        "owner_id": str(OWNER),
        "task_id": task["id"],
        "kind": kind,
        "trigger_at": trigger_at.isoformat(),
        "snooze_count": 0,
        "task_bubbles": task,
    }


class FakeWorld:
    """Just enough of the database and Expo for the dispatcher."""

    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.tokens: list[str] = ["ExponentPushToken[good]"]
        self.deleted_tokens: list[str] = []
        self.pushes: list[dict] = []
        self.ticket_for: dict[str, dict] = {}
        self.inserted: list[dict] = []

    async def mark_state(self, ids, state):
        for plan_id in ids:
            self.states[plan_id] = state
        return len(ids)

    async def count_sent_since(self, owner_id, since):
        return 0

    async def insert_plans(self, rows):
        self.inserted.extend(rows)
        return rows

    async def list_tokens(self, owner_id):
        return list(self.tokens)

    async def delete_dead_token(self, token):
        self.deleted_tokens.append(token)
        self.tokens = [t for t in self.tokens if t != token]

    async def send_push(self, tokens, **payload):
        self.pushes.append({"tokens": list(tokens), **payload})
        return [
            {**self.ticket_for.get(tok, {"status": "ok", "id": "x"}), "token": tok}
            for tok in tokens
        ]


@pytest.fixture
def world(monkeypatch) -> FakeWorld:
    fake = FakeWorld()

    async def preferences_for(owner_id):
        return PREFS

    async def no_clusters(owner_id):
        return []

    monkeypatch.setattr(dispatcher, "preferences_for", preferences_for)
    monkeypatch.setattr(dispatcher, "send_push", fake.send_push)
    monkeypatch.setattr(dispatcher.notifications_db, "mark_state", fake.mark_state)
    monkeypatch.setattr(dispatcher.notifications_db, "count_sent_since", fake.count_sent_since)
    monkeypatch.setattr(dispatcher.notifications_db, "insert_plans", fake.insert_plans)
    monkeypatch.setattr(dispatcher.device_tokens_db, "list_tokens_for_user", fake.list_tokens)
    monkeypatch.setattr(dispatcher.device_tokens_db, "delete_dead_token", fake.delete_dead_token, raising=False)
    monkeypatch.setattr(dispatcher.clusters_db, "fetch_clusters_for_user", no_clusters)
    return fake


# ---------------------------------------------------------------------------
# One push per task per tick
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_task_whose_due_and_chase_land_together_gets_one_push(world):
    """Quiet hours move every deferred plan to the same morning minute, so a
    task's due and chase fired together: two pushes, two budget slots."""
    task = _task(str(uuid4()))
    due = _plan(task, "due", NOW - timedelta(minutes=1))
    chase = _plan(task, "chase", NOW - timedelta(minutes=1))

    result = await dispatcher._dispatch_for_owner(OWNER, [due, chase], NOW)

    assert len(world.pushes) == 1
    assert world.pushes[0]["data"]["kind"] == "chase"
    assert world.states[chase["id"]] == "sent"
    assert world.states[due["id"]] == "cancelled"
    assert result["sent"] == 1


@pytest.mark.asyncio
async def test_different_tasks_due_together_each_get_their_push(world):
    first, second = _task(str(uuid4())), _task(str(uuid4()), title="Ligar ao banco")
    plans = [_plan(first, "due", NOW), _plan(second, "due", NOW)]

    await dispatcher._dispatch_for_owner(OWNER, plans, NOW)

    assert len(world.pushes) == 2


# ---------------------------------------------------------------------------
# Dead tokens and rejected pushes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_token_expo_calls_unregistered_is_deleted_and_not_used_again(world):
    world.tokens = ["ExponentPushToken[dead]", "ExponentPushToken[good]"]
    world.ticket_for["ExponentPushToken[dead]"] = {
        "status": "error",
        "message": "not registered",
        "details": {"error": "DeviceNotRegistered"},
    }
    first, second = _task(str(uuid4())), _task(str(uuid4()))
    plans = [_plan(first, "due", NOW), _plan(second, "due", NOW)]

    await dispatcher._dispatch_for_owner(OWNER, plans, NOW)

    assert world.deleted_tokens == ["ExponentPushToken[dead]"]
    assert world.pushes[1]["tokens"] == ["ExponentPushToken[good]"]
    # The good token accepted both, so both were delivered.
    assert all(world.states[p["id"]] == "sent" for p in plans)


@pytest.mark.asyncio
async def test_a_recently_rejected_push_stays_pending_for_a_retry(world):
    world.ticket_for["ExponentPushToken[good]"] = {"status": "error", "message": "blip"}
    plan = _plan(_task(str(uuid4())), "due", NOW - timedelta(minutes=5))

    await dispatcher._dispatch_for_owner(OWNER, [plan], NOW)

    assert plan["id"] not in world.states  # untouched: still pending


@pytest.mark.asyncio
async def test_a_push_rejected_for_hours_is_given_up_on(world):
    """Retried every minute forever, the oldest-first tick would eventually
    fill with them and starve every other reminder."""
    world.ticket_for["ExponentPushToken[good]"] = {"status": "error", "message": "bad"}
    plan = _plan(_task(str(uuid4())), "due", NOW - dispatcher.FAILED_PUSH_GIVE_UP - timedelta(minutes=1))

    result = await dispatcher._dispatch_for_owner(OWNER, [plan], NOW)

    assert world.states[plan["id"]] == "skipped"
    assert result["skipped"] == 1


# ---------------------------------------------------------------------------
# Replanning from the task as it is now
# ---------------------------------------------------------------------------

@pytest.fixture
def plan_store(monkeypatch):
    """Pending plans per task, with the partial unique index's behaviour."""
    store: dict = {"pending": [], "task": None, "fail_next_insert": False}

    async def fetch_task_by_id(task_id, owner_id):
        return store["task"]

    async def fetch_pending_for_task(task_id):
        return list(store["pending"])

    async def cancel_pending_for_task(task_id):
        store["pending"] = []
        return 0

    async def insert_plans(rows):
        if store["fail_next_insert"]:
            store["fail_next_insert"] = False
            raise RuntimeError("duplicate key value violates unique constraint")
        store["pending"] = [{"kind": r["kind"], "trigger_at": r["trigger_at"]} for r in rows]
        return rows

    async def no_cluster(cluster_id, owner_id):
        return None

    monkeypatch.setattr(dispatcher.tasks_db, "fetch_task_by_id", fetch_task_by_id)
    monkeypatch.setattr(dispatcher.notifications_db, "fetch_pending_for_task", fetch_pending_for_task)
    monkeypatch.setattr(dispatcher.notifications_db, "cancel_pending_for_task", cancel_pending_for_task)
    monkeypatch.setattr(dispatcher.notifications_db, "insert_plans", insert_plans)
    monkeypatch.setattr(dispatcher.clusters_db, "fetch_cluster_by_id", no_cluster)
    return store


def _due_trigger(store) -> str | None:
    return next((p["trigger_at"] for p in store["pending"] if p["kind"] == "due"), None)


@pytest.mark.asyncio
async def test_replanning_uses_the_saved_task_not_the_callers_stale_copy(plan_store):
    """Two quick edits finish in either order. Planning from the row a request
    wrote let the older edit's schedule land last."""
    task_id = str(uuid4())
    moved = NOW + timedelta(days=2, hours=3)  # 13:00 Lisbon, outside quiet hours
    plan_store["task"] = _task(task_id, due_at=moved.isoformat())
    stale_copy = _task(task_id, due_at=(NOW + timedelta(hours=5)).isoformat())

    await dispatcher.sync_task_plans(stale_copy, OWNER, preferences=PREFS, now=NOW)

    assert _due_trigger(plan_store) == moved.isoformat()


@pytest.mark.asyncio
async def test_losing_an_insert_race_rechecks_and_rewrites_the_schedule(plan_store):
    task_id = str(uuid4())
    moved = NOW + timedelta(days=2, hours=3)
    plan_store["task"] = _task(task_id, due_at=moved.isoformat())
    # What the race's winner left behind: the schedule for an older deadline.
    plan_store["pending"] = [{"kind": "due", "trigger_at": (NOW + timedelta(hours=5)).isoformat()}]
    plan_store["fail_next_insert"] = True

    await dispatcher.sync_task_plans(plan_store["task"], OWNER, preferences=PREFS, now=NOW)

    assert _due_trigger(plan_store) == moved.isoformat()


# ---------------------------------------------------------------------------
# Snooze: postponing the reminder vs. postponing the task
# ---------------------------------------------------------------------------

@pytest.fixture
def snooze_world(monkeypatch):
    calls: dict = {"task_updates": [], "rearmed": None, "states": {}, "synced": False}
    task_holder: dict = {}

    async def fetch_owned(plan_id, owner_id):
        return {"id": str(plan_id), "task_id": task_holder["task"]["id"], "kind": "lead",
                "trigger_at": NOW.isoformat(), "state": "sent", "snooze_count": 0,
                "sent_at": NOW.isoformat()}

    async def fetch_task_by_id(task_id, owner_id):
        return task_holder["task"]

    async def update_task(task_id, owner_id, fields):
        calls["task_updates"].append(fields)
        return {**task_holder["task"], **fields}

    async def snooze(plan_id, trigger_at, snooze_count):
        calls["rearmed"] = trigger_at
        return {"id": str(plan_id), "task_id": task_holder["task"]["id"], "kind": "lead",
                "trigger_at": trigger_at.isoformat(), "state": "pending",
                "snooze_count": snooze_count, "sent_at": None}

    async def mark_state(ids, state):
        for plan_id in ids:
            calls["states"][plan_id] = state

    async def sync_task_plans(task, owner_id):
        calls["synced"] = True

    async def fetch_pending_for_task(task_id):
        return []

    async def preferences_for(owner_id):
        return PREFS

    monkeypatch.setattr(router.notifications_db, "fetch_owned", fetch_owned)
    monkeypatch.setattr(router.notifications_db, "snooze", snooze)
    monkeypatch.setattr(router.notifications_db, "mark_state", mark_state)
    monkeypatch.setattr(router.notifications_db, "fetch_pending_for_task", fetch_pending_for_task)
    monkeypatch.setattr(router.tasks_db, "fetch_task_by_id", fetch_task_by_id)
    monkeypatch.setattr(router.tasks_db, "update_task", update_task)
    monkeypatch.setattr(router.reminder_dispatcher, "sync_task_plans", sync_task_plans)
    monkeypatch.setattr(router.reminder_dispatcher, "preferences_for", preferences_for)
    return calls, task_holder


@pytest.mark.asyncio
async def test_snoozing_a_heads_up_does_not_pull_the_deadline_earlier(snooze_world):
    """The reported shape: 'Snooze 1h' on a reminder for something due
    tomorrow made it due in an hour, and red long before it was late."""
    calls, holder = snooze_world
    due_tomorrow = datetime.now(UTC) + timedelta(days=1)
    holder["task"] = _task(str(uuid4()), due_at=due_tomorrow.isoformat())

    await router.snooze_plan(uuid4(), router.SnoozeRequest(minutes=60), user_id=OWNER)

    assert calls["task_updates"] == []  # the task is untouched
    assert calls["rearmed"] is not None
    assert calls["rearmed"] < due_tomorrow


@pytest.mark.asyncio
async def test_snoozing_past_the_deadline_postpones_the_task(snooze_world):
    calls, holder = snooze_world
    in_ten_minutes = datetime.now(UTC) + timedelta(minutes=10)
    holder["task"] = _task(str(uuid4()), due_at=in_ten_minutes.isoformat())

    before = datetime.now(UTC)
    await router.snooze_plan(uuid4(), router.SnoozeRequest(minutes=60), user_id=OWNER)

    new_due = datetime.fromisoformat(calls["task_updates"][0]["due_at"])
    assert new_due >= before + timedelta(minutes=59)
    assert calls["synced"]


@pytest.mark.asyncio
async def test_snoozing_an_overdue_task_postpones_it(snooze_world):
    calls, holder = snooze_world
    holder["task"] = _task(str(uuid4()), due_at=(datetime.now(UTC) - timedelta(hours=2)).isoformat())

    await router.snooze_plan(uuid4(), router.SnoozeRequest(minutes=60), user_id=OWNER)

    assert len(calls["task_updates"]) == 1


# ---------------------------------------------------------------------------
# Answering a chase stops the escalation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_answering_cancels_the_pending_escalation(monkeypatch):
    """The escalation is planned when the chase goes out. A reply used to be
    met a day later with 'Still open — worth a decision.'"""
    task_id = str(uuid4())
    plan_id = uuid4()
    cancelled: list = []

    async def fetch_owned(pid, owner_id):
        return {"id": str(pid), "task_id": task_id, "kind": "chase", "trigger_at": NOW.isoformat(),
                "state": "sent", "snooze_count": 0, "sent_at": None}

    async def mark_state(ids, state):
        return len(ids)

    async def cancel_kinds(tid, kinds):
        cancelled.append((str(tid), kinds))
        return 1

    async def fetch_one(pid):
        return {"id": str(pid), "task_id": task_id, "kind": "chase", "trigger_at": NOW.isoformat(),
                "state": "answered", "snooze_count": 0, "sent_at": None}

    monkeypatch.setattr(router.notifications_db, "fetch_owned", fetch_owned)
    monkeypatch.setattr(router.notifications_db, "mark_state", mark_state)
    monkeypatch.setattr(router.notifications_db, "cancel_pending_kinds_for_task", cancel_kinds, raising=False)
    monkeypatch.setattr(router.notifications_db, "fetch_one", fetch_one)

    await router.mark_plan_answered(plan_id, user_id=OWNER)

    assert cancelled == [(task_id, ["escalate"])]


# ---------------------------------------------------------------------------
# The low-importance chase after a late-night deadline
# ---------------------------------------------------------------------------

def test_a_deadline_after_midnight_is_chased_that_same_morning():
    """Due 02:30 in Lisbon: its next morning is 07:00 the same day. Adding a
    day unconditionally chased it some 30 hours after the deadline."""
    due = datetime(2026, 9, 26, 1, 30, tzinfo=UTC)  # 02:30 Lisbon
    task = _task(str(uuid4()), importance=2, due_at=due.isoformat())
    plans = plan_for_task(task, PREFS, now=due - timedelta(hours=1))
    chase = next(p for p in plans if p.kind == "chase")
    assert chase.trigger_at == datetime(2026, 9, 26, 6, 0, tzinfo=UTC)  # 07:00 Lisbon


def test_an_afternoon_deadline_is_still_chased_the_next_morning():
    due = datetime(2026, 9, 26, 14, 0, tzinfo=UTC)  # 15:00 Lisbon
    task = _task(str(uuid4()), importance=2, due_at=due.isoformat())
    plans = plan_for_task(task, PREFS, now=due - timedelta(hours=1))
    chase = next(p for p in plans if p.kind == "chase")
    assert chase.trigger_at == datetime(2026, 9, 27, 6, 0, tzinfo=UTC)


def test_quiet_window_reads_preferences_with_defaults():
    zone, start, end = dispatcher.quiet_window({"timezone": "Europe/Lisbon"})
    assert str(zone) == "Europe/Lisbon"
    assert (start, end) == (time(22, 0), time(8, 0))
