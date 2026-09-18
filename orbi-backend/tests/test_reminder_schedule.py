"""Tests for the reminder timing policy.

reminder_schedule.py is pure by design so the whole policy can be pinned
against a frozen clock. Everything here runs without a database, a network,
or an API key.
"""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.services.reminder_schedule import (
    daily_budget,
    escalation_for,
    in_quiet_hours,
    plan_for_task,
    rank_for_budget,
    resolve_zone,
    shift_out_of_quiet_hours,
)

UTC = timezone.utc

# A Friday morning, chosen so nothing in these tests straddles a DST change.
NOW = datetime(2026, 9, 18, 9, 0, tzinfo=UTC)

BASE_PREFERENCES = {
    "reminders_enabled": True,
    "lead_reminders_enabled": True,
    "chase_reminders_enabled": True,
    "quiet_hours_start": "22:00:00",
    "quiet_hours_end": "08:00:00",
    "proactivity_level": 3,
    "timezone": "UTC",
    "language": "en-GB",
}


def make_task(**overrides) -> dict:
    task = {
        "id": "11111111-1111-1111-1111-111111111111",
        "title": "Renew the car insurance",
        "status": "active",
        "importance": 5,
        "due_at": datetime(2026, 9, 20, 15, 0, tzinfo=UTC).isoformat(),
        "parent_cluster_id": None,
    }
    task.update(overrides)
    return task


def kinds(plans) -> set[str]:
    return {p.kind for p in plans}


def trigger_for(plans, kind: str) -> datetime:
    return next(p.trigger_at for p in plans if p.kind == kind)


# ---------------------------------------------------------------------------
# Eligibility — the cases that must produce nothing at all
# ---------------------------------------------------------------------------

def test_task_without_deadline_gets_no_reminders():
    """Every event is defined relative to due_at; without one there is
    nothing honest to schedule."""
    plans = plan_for_task(make_task(due_at=None), BASE_PREFERENCES, now=NOW)
    assert plans == []


def test_completed_task_gets_no_reminders():
    plans = plan_for_task(make_task(status="completed"), BASE_PREFERENCES, now=NOW)
    assert plans == []


def test_reminders_disabled_silences_everything():
    prefs = {**BASE_PREFERENCES, "reminders_enabled": False}
    assert plan_for_task(make_task(), prefs, now=NOW) == []


def test_muted_cluster_silences_everything():
    plans = plan_for_task(make_task(), BASE_PREFERENCES, now=NOW, cluster_muted=True)
    assert plans == []


def test_missing_preferences_row_still_schedules():
    """An empty dict means "user never opened Settings", which has to mean
    defaults — not silence, or the feature is invisible by default."""
    plans = plan_for_task(make_task(), {}, now=NOW)
    assert kinds(plans) == {"lead", "due", "chase"}


# ---------------------------------------------------------------------------
# Lead time scales with importance
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "importance,expected_lead",
    [
        (10, timedelta(days=1)),
        (9, timedelta(days=1)),
        (8, timedelta(hours=4)),
        (6, timedelta(hours=2)),
        (4, timedelta(hours=1)),
        (1, timedelta(minutes=30)),
    ],
)
def test_lead_offset_scales_with_importance(importance, expected_lead):
    task = make_task(importance=importance)
    plans = plan_for_task(task, BASE_PREFERENCES, now=NOW)
    due = datetime(2026, 9, 20, 15, 0, tzinfo=UTC)
    assert trigger_for(plans, "lead") == due - expected_lead


def test_only_one_lead_per_task():
    """Importance buys a longer runway, never extra interruptions."""
    plans = plan_for_task(make_task(importance=10), BASE_PREFERENCES, now=NOW)
    assert len([p for p in plans if p.kind == "lead"]) == 1


def test_lead_can_be_disabled_on_its_own():
    prefs = {**BASE_PREFERENCES, "lead_reminders_enabled": False}
    assert kinds(plan_for_task(make_task(), prefs, now=NOW)) == {"due", "chase"}


def test_chase_can_be_disabled_on_its_own():
    prefs = {**BASE_PREFERENCES, "chase_reminders_enabled": False}
    assert kinds(plan_for_task(make_task(), prefs, now=NOW)) == {"lead", "due"}


# ---------------------------------------------------------------------------
# Chase delay
# ---------------------------------------------------------------------------

def test_important_task_is_chased_within_the_hour():
    plans = plan_for_task(make_task(importance=9), BASE_PREFERENCES, now=NOW)
    due = datetime(2026, 9, 20, 15, 0, tzinfo=UTC)
    assert trigger_for(plans, "chase") == due + timedelta(minutes=30)


def test_mid_importance_task_is_chased_after_two_hours():
    plans = plan_for_task(make_task(importance=6), BASE_PREFERENCES, now=NOW)
    due = datetime(2026, 9, 20, 15, 0, tzinfo=UTC)
    assert trigger_for(plans, "chase") == due + timedelta(hours=2)


def test_low_importance_task_is_chased_the_next_morning():
    """Nobody needs to be asked at 22:40 whether they renewed the library
    book — the low-importance chase waits for the morning."""
    plans = plan_for_task(make_task(importance=2), BASE_PREFERENCES, now=NOW)
    assert trigger_for(plans, "chase") == datetime(2026, 9, 21, 8, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Triggers already in the past
# ---------------------------------------------------------------------------

def test_past_triggers_are_dropped_not_fired_immediately():
    """A task saved fifteen minutes before its own deadline must not
    detonate the lead notification on save."""
    now = datetime(2026, 9, 20, 14, 45, tzinfo=UTC)
    plans = plan_for_task(make_task(importance=6), BASE_PREFERENCES, now=now)
    assert kinds(plans) == {"due", "chase"}


def test_task_created_after_its_deadline_schedules_only_the_chase():
    now = datetime(2026, 9, 20, 16, 0, tzinfo=UTC)
    plans = plan_for_task(make_task(importance=6), BASE_PREFERENCES, now=now)
    assert kinds(plans) == {"chase"}


# ---------------------------------------------------------------------------
# Quiet hours
# ---------------------------------------------------------------------------

def test_quiet_window_wrapping_midnight():
    """22:00 -> 08:00 is the default and cannot be tested as start <= t <= end,
    which is false for every hour of a wrapping window."""
    start, end = time(22, 0), time(8, 0)
    assert in_quiet_hours(datetime(2026, 9, 18, 23, 30, tzinfo=UTC), start, end)
    assert in_quiet_hours(datetime(2026, 9, 18, 3, 0, tzinfo=UTC), start, end)
    assert not in_quiet_hours(datetime(2026, 9, 18, 12, 0, tzinfo=UTC), start, end)
    assert not in_quiet_hours(datetime(2026, 9, 18, 8, 0, tzinfo=UTC), start, end)


def test_quiet_window_within_one_day():
    start, end = time(1, 0), time(6, 0)
    assert in_quiet_hours(datetime(2026, 9, 18, 3, 0, tzinfo=UTC), start, end)
    assert not in_quiet_hours(datetime(2026, 9, 18, 23, 0, tzinfo=UTC), start, end)


def test_zero_width_quiet_window_is_never_quiet():
    """Equal start and end means the user switched quiet hours off. Reading
    it as "always quiet" would mute the app permanently."""
    assert not in_quiet_hours(
        datetime(2026, 9, 18, 3, 0, tzinfo=UTC), time(8, 0), time(8, 0)
    )


def test_trigger_inside_quiet_hours_moves_forward_to_morning():
    moment = datetime(2026, 9, 19, 3, 0, tzinfo=UTC)
    shifted = shift_out_of_quiet_hours(moment, ZoneInfo("UTC"), time(22, 0), time(8, 0))
    assert shifted == datetime(2026, 9, 19, 8, 0, tzinfo=UTC)


def test_trigger_late_at_night_moves_to_the_following_morning():
    moment = datetime(2026, 9, 19, 23, 0, tzinfo=UTC)
    shifted = shift_out_of_quiet_hours(moment, ZoneInfo("UTC"), time(22, 0), time(8, 0))
    assert shifted == datetime(2026, 9, 20, 8, 0, tzinfo=UTC)


def test_trigger_outside_quiet_hours_is_untouched():
    moment = datetime(2026, 9, 19, 14, 0, tzinfo=UTC)
    assert (
        shift_out_of_quiet_hours(moment, ZoneInfo("UTC"), time(22, 0), time(8, 0))
        == moment
    )


def test_lead_pushed_past_its_own_deadline_is_dropped():
    """A deadline at 07:00 puts the lead at 05:00, inside quiet hours.
    Shifting it to 08:00 would place the warning after the thing it warns
    about — so it is dropped and `due` carries the message."""
    task = make_task(
        importance=6, due_at=datetime(2026, 9, 20, 7, 0, tzinfo=UTC).isoformat()
    )
    plans = plan_for_task(task, BASE_PREFERENCES, now=NOW)
    assert kinds(plans) == {"due", "chase"}
    assert trigger_for(plans, "due") == datetime(2026, 9, 20, 8, 0, tzinfo=UTC)


def test_quiet_hours_are_evaluated_in_the_users_zone():
    """A deadline at 23:30 in Lisbon is quiet in Lisbon. Evaluated in UTC it
    would look like 22:30 and get shifted a day differently."""
    lisbon = ZoneInfo("Europe/Lisbon")
    local_due = datetime(2026, 9, 20, 23, 30, tzinfo=lisbon)
    task = make_task(importance=6, due_at=local_due.astimezone(UTC).isoformat())
    prefs = {**BASE_PREFERENCES, "timezone": "Europe/Lisbon"}

    due_trigger = trigger_for(plan_for_task(task, prefs, now=NOW), "due")
    assert due_trigger.astimezone(lisbon).hour == 8
    assert due_trigger.astimezone(lisbon).date() == local_due.date() + timedelta(days=1)


def test_unknown_timezone_falls_back_to_utc():
    """A stale client sending a zone this build cannot resolve must still get
    reminders, just in UTC — never silence."""
    assert resolve_zone("Mars/Olympus_Mons") == ZoneInfo("UTC")
    assert resolve_zone(None) == ZoneInfo("UTC")
    assert resolve_zone("Europe/Lisbon") == ZoneInfo("Europe/Lisbon")


# ---------------------------------------------------------------------------
# Budget and ranking
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "level,expected", [(1, 2), (2, 4), (3, 6), (4, 10), (5, 20)]
)
def test_daily_budget_per_proactivity_level(level, expected):
    assert daily_budget(level) == expected


def test_unset_proactivity_level_uses_the_database_default():
    assert daily_budget(None) == daily_budget(3)
    assert daily_budget(99) == daily_budget(3)


def test_ranking_puts_escalations_and_due_notices_first():
    """Kind outranks pressure: something you were already asked about beats
    a higher-scoring task you have not been told about yet."""
    plans = [
        {"kind": "lead", "pressure_score": 9.9, "trigger_at": "2026-09-18T09:00:00Z"},
        {"kind": "chase", "pressure_score": 1.0, "trigger_at": "2026-09-18T09:00:00Z"},
        {"kind": "due", "pressure_score": 1.0, "trigger_at": "2026-09-18T09:00:00Z"},
        {"kind": "escalate", "pressure_score": 0.1, "trigger_at": "2026-09-18T09:00:00Z"},
    ]
    assert [p["kind"] for p in rank_for_budget(plans)] == [
        "escalate",
        "due",
        "chase",
        "lead",
    ]


def test_ranking_breaks_ties_on_pressure_then_time():
    plans = [
        {"kind": "due", "pressure_score": 3.0, "trigger_at": "2026-09-18T09:00:00Z"},
        {"kind": "due", "pressure_score": 8.0, "trigger_at": "2026-09-18T10:00:00Z"},
        {"kind": "due", "pressure_score": 8.0, "trigger_at": "2026-09-18T08:00:00Z"},
    ]
    ranked = rank_for_budget(plans)
    assert [p["trigger_at"] for p in ranked] == [
        "2026-09-18T08:00:00Z",
        "2026-09-18T10:00:00Z",
        "2026-09-18T09:00:00Z",
    ]


def test_ranking_tolerates_a_missing_pressure_score():
    """The score arrives from an embedded join that can come back null."""
    plans = [
        {"kind": "due", "pressure_score": None, "trigger_at": "2026-09-18T09:00:00Z"},
        {"kind": "due", "pressure_score": 5.0, "trigger_at": "2026-09-18T09:00:00Z"},
    ]
    assert rank_for_budget(plans)[0]["pressure_score"] == 5.0


# ---------------------------------------------------------------------------
# Escalation
# ---------------------------------------------------------------------------

def test_escalation_lands_a_day_after_the_chase():
    chase_at = datetime(2026, 9, 20, 17, 0, tzinfo=UTC)
    escalation = escalation_for(chase_at, BASE_PREFERENCES)
    assert escalation.kind == "escalate"
    assert escalation.trigger_at == datetime(2026, 9, 21, 17, 0, tzinfo=UTC)


def test_escalation_respects_quiet_hours():
    chase_at = datetime(2026, 9, 20, 23, 30, tzinfo=UTC)
    escalation = escalation_for(chase_at, BASE_PREFERENCES)
    assert escalation.trigger_at == datetime(2026, 9, 22, 8, 0, tzinfo=UTC)
