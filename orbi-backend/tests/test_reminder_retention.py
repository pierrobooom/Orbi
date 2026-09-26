"""Finished reminder rows are pruned; owed ones never are.

Unpruned history is what broke Snooze: a user passed 200 rows and a lookup
that scanned the first 200 stopped finding the newest reminder.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services import reminder_dispatcher as dispatcher

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def deletes(monkeypatch):
    """Record every delete the pruner asks for."""
    calls: list[tuple[list[str], datetime]] = []

    async def delete_finished_before(states, before):
        calls.append((list(states), before))
        return 3

    monkeypatch.setattr(dispatcher.notifications_db, "delete_finished_before", delete_finished_before)
    monkeypatch.setattr(dispatcher, "_last_prune", None)
    return calls


@pytest.mark.asyncio
async def test_cancelled_rows_go_after_a_week_and_told_rows_after_a_month(deletes):
    deleted = await dispatcher.prune_history(NOW)

    windows = {tuple(sorted(states)): NOW - before for states, before in deletes}
    assert windows[("cancelled",)] == timedelta(days=7)
    assert windows[("answered", "sent", "skipped")] == timedelta(days=30)
    assert deleted == 6


@pytest.mark.asyncio
async def test_pending_is_never_pruned(deletes):
    await dispatcher.prune_history(NOW)
    assert all("pending" not in states for states, _ in deletes)


@pytest.mark.asyncio
async def test_prune_runs_at_most_once_per_window(deletes):
    await dispatcher._prune_if_due(NOW)
    await dispatcher._prune_if_due(NOW + timedelta(minutes=1))
    assert len(deletes) == 2  # one run, two windows

    await dispatcher._prune_if_due(NOW + dispatcher.PRUNE_EVERY)
    assert len(deletes) == 4


@pytest.mark.asyncio
async def test_a_failing_prune_never_fails_the_tick(monkeypatch):
    async def broken(states, before):
        raise RuntimeError("database away")

    monkeypatch.setattr(dispatcher.notifications_db, "delete_finished_before", broken)
    monkeypatch.setattr(dispatcher, "_last_prune", None)
    await dispatcher._prune_if_due(NOW)  # must not raise
