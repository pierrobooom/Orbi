from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.models.task import TaskBubble, TaskStatus, Visibility
from app.services.scoring import (
    _attention_decay,
    _deadline_weight,
    _dependency_weight,
    _importance_weight,
    calculate_pressure_score,
)


def make_task(**overrides) -> TaskBubble:
    """Return a minimal valid TaskBubble with sensible defaults."""
    now = datetime.now(timezone.utc)
    defaults = {
        "id": uuid4(),
        "owner_id": uuid4(),
        "title": "Test task",
        "status": TaskStatus.active,
        "importance": 5,
        "urgency_score": 0.0,
        "pressure_score": 0.0,
        "source_type": "manual",
        "confidence": 1.0,
        "visibility": Visibility.private,
        "created_at": now,
        "updated_at": now,
    }
    defaults.update(overrides)
    return TaskBubble(**defaults)


# ---------------------------------------------------------------------------
# deadline_weight
# ---------------------------------------------------------------------------

class TestDeadlineWeight:
    def test_no_due_date_returns_zero(self):
        assert _deadline_weight(None) == 0.0

    def test_overdue_returns_ten(self):
        past = datetime.now(timezone.utc) - timedelta(days=1)
        assert _deadline_weight(past) == 10.0

    def test_one_day_away_returns_eight(self):
        soon = datetime.now(timezone.utc) + timedelta(hours=20)
        assert _deadline_weight(soon) == 8.0

    def test_three_days_away_returns_five(self):
        close = datetime.now(timezone.utc) + timedelta(days=2)
        assert _deadline_weight(close) == 5.0

    def test_seven_days_away_returns_two(self):
        week = datetime.now(timezone.utc) + timedelta(days=5)
        assert _deadline_weight(week) == 2.0

    def test_beyond_seven_days_returns_zero(self):
        far = datetime.now(timezone.utc) + timedelta(days=30)
        assert _deadline_weight(far) == 0.0

    def test_naive_datetime_is_handled(self):
        # Naive datetimes should not raise — treated as UTC
        past = datetime.utcnow() - timedelta(days=1)
        assert _deadline_weight(past) == 10.0


# ---------------------------------------------------------------------------
# importance_weight
# ---------------------------------------------------------------------------

class TestImportanceWeight:
    def test_importance_one(self):
        assert _importance_weight(1) == 0.5

    def test_importance_five(self):
        assert _importance_weight(5) == 2.5

    def test_importance_ten(self):
        assert _importance_weight(10) == 5.0


# ---------------------------------------------------------------------------
# dependency_weight
# ---------------------------------------------------------------------------

class TestDependencyWeight:
    def test_zero_dependencies(self):
        assert _dependency_weight(0) == 0.0

    def test_one_dependency(self):
        assert _dependency_weight(1) == 1.0

    def test_two_dependencies(self):
        assert _dependency_weight(2) == 1.0

    def test_three_dependencies(self):
        assert _dependency_weight(3) == 2.0

    def test_many_dependencies(self):
        assert _dependency_weight(10) == 2.0


# ---------------------------------------------------------------------------
# attention_decay
# ---------------------------------------------------------------------------

class TestAttentionDecay:
    def test_recently_updated_returns_zero(self):
        now = datetime.now(timezone.utc)
        assert _attention_decay(now) == 0.0

    def test_eight_days_old_returns_one_point_five(self):
        stale = datetime.now(timezone.utc) - timedelta(days=8)
        assert _attention_decay(stale) == 1.5

    def test_fifteen_days_old_returns_three(self):
        old = datetime.now(timezone.utc) - timedelta(days=15)
        assert _attention_decay(old) == 3.0

    def test_naive_datetime_is_handled(self):
        stale = datetime.utcnow() - timedelta(days=8)
        assert _attention_decay(stale) == 1.5


# ---------------------------------------------------------------------------
# calculate_pressure_score (integration)
# ---------------------------------------------------------------------------

class TestCalculatePressureScore:
    def test_score_is_clamped_to_ten(self):
        # Overdue + max importance + many deps + stale = would exceed 10
        overdue = datetime.now(timezone.utc) - timedelta(days=1)
        stale = datetime.now(timezone.utc) - timedelta(days=20)
        task = make_task(due_at=overdue, importance=10, updated_at=stale)
        score = calculate_pressure_score(task, dependency_count=5)
        assert score == 10.0

    def test_score_is_never_negative(self):
        task = make_task(importance=1)
        score = calculate_pressure_score(task, dependency_count=0)
        assert score >= 0.0

    def test_no_pressure_on_fresh_low_importance_task(self):
        task = make_task(importance=1)
        score = calculate_pressure_score(task, dependency_count=0)
        # Only importance_weight contributes: 1/2 = 0.5
        assert score == 0.5

    def test_dependency_count_default_is_zero(self):
        task = make_task(importance=4)
        score_explicit = calculate_pressure_score(task, dependency_count=0)
        score_default = calculate_pressure_score(task)
        assert score_explicit == score_default


# ---------------------------------------------------------------------------
# Weekday resolution (time_extractor)
# ---------------------------------------------------------------------------
# Regression coverage for the bug where "Friday morning" spoken on a
# Saturday came back as the following Sunday: the model is unreliable at
# calendar arithmetic, and the sanitiser only rejects implausible dates,
# so a wrong weekday reached the user's reminder untouched.

from app.services.time_extractor import (  # noqa: E402
    extract_weekday,
    resolve_weekday_date,
)


class TestWeekdayExtraction:
    def test_english_weekday(self):
        assert extract_weekday("Book the dentist for Friday morning") == (4, False)

    def test_english_next_marker(self):
        assert extract_weekday("next Friday at 3pm") == (4, True)

    def test_portuguese_weekday(self):
        assert extract_weekday("marca para sexta de manha") == (4, False)

    def test_portuguese_accented_and_feira(self):
        assert extract_weekday("na terça-feira") == (1, False)

    def test_portuguese_next_marker(self):
        assert extract_weekday("na próxima sexta") == (4, True)

    def test_no_weekday_returns_none(self):
        assert extract_weekday("buy milk tomorrow") is None

    def test_empty_transcript(self):
        assert extract_weekday("") is None


class TestResolveWeekdayDate:
    def test_forward_within_week(self):
        # Saturday 2026-08-29 -> Friday is 2026-09-04, not the next day.
        saturday = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
        assert resolve_weekday_date(saturday, 4).date() == date(2026, 9, 4)

    def test_same_weekday_means_today(self):
        saturday = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
        assert resolve_weekday_date(saturday, 5).date() == date(2026, 8, 29)

    def test_explicit_next_skips_a_week(self):
        saturday = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
        got = resolve_weekday_date(saturday, 4, explicit_next=True)
        assert got.date() == date(2026, 9, 11)

    def test_time_of_day_is_preserved(self):
        saturday = datetime(2026, 8, 29, 18, 30, tzinfo=timezone.utc)
        got = resolve_weekday_date(saturday, 0)
        assert (got.hour, got.minute) == (18, 30)
