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

    def test_overdue_scores_high_and_escalates_with_age(self):
        """Being late escalates, but tops out: three days late and three
        weeks late are both simply late, and letting age dominate would bury
        genuinely urgent new work."""
        now = datetime.now(timezone.utc)
        just = _deadline_weight(now - timedelta(minutes=5))
        a_day = _deadline_weight(now - timedelta(days=1))
        a_week = _deadline_weight(now - timedelta(days=7))

        assert 8.0 <= just < a_day < 10.0
        assert a_week == 10.0

    def test_weight_decreases_smoothly_as_the_deadline_recedes(self):
        """The property that matters, and the one the old step function did
        not have: moving a deadline ALWAYS moves the score. It used to be a
        flat 8 from one minute to twenty-three hours, so postponing did
        nothing observable and the bubble kept screaming."""
        now = datetime.now(timezone.utc)
        weights = [
            _deadline_weight(now + timedelta(hours=h))
            for h in (1, 3, 12, 24, 72, 168, 336)
        ]
        assert weights == sorted(weights, reverse=True)
        assert len(set(weights)) == len(weights), "no two horizons may tie"

    def test_roughly_tracks_the_old_steps_at_the_old_boundaries(self):
        """Existing tasks should stay ranked about where their owner expects,
        so the curve is tuned to pass near the previous values."""
        now = datetime.now(timezone.utc)
        assert 6.0 < _deadline_weight(now + timedelta(days=1)) < 7.0   # was 8
        assert 3.5 < _deadline_weight(now + timedelta(days=3)) < 4.5   # was 5
        assert 1.2 < _deadline_weight(now + timedelta(days=7)) < 2.2   # was 2

    def test_distant_deadline_approaches_zero(self):
        far = datetime.now(timezone.utc) + timedelta(days=60)
        assert _deadline_weight(far) < 0.1

    def test_naive_datetime_is_handled(self):
        # Naive datetimes should not raise — treated as UTC
        past = datetime.now() - timedelta(days=7)
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
    def test_score_never_exceeds_ten(self):
        """Soft saturation replaced a hard clamp. The clamp destroyed
        information — an ordinary task due tomorrow already summed past 10 and
        so scored identically to the worst thing in the universe, and any
        change below the ceiling moved nothing."""
        overdue = datetime.now(timezone.utc) - timedelta(days=7)
        stale = datetime.now(timezone.utc) - timedelta(days=20)
        task = make_task(due_at=overdue, importance=10, updated_at=stale)
        score = calculate_pressure_score(task, dependency_count=5)
        assert 9.0 < score <= 10.0

    def test_every_component_still_moves_the_score_near_the_top(self):
        """The reason for the change. Under the old clamp these two were both
        exactly 10, so de-prioritising a task did nothing visible."""
        overdue = datetime.now(timezone.utc) - timedelta(days=2)
        urgent = make_task(due_at=overdue, importance=10)
        milder = make_task(due_at=overdue, importance=4)
        assert calculate_pressure_score(urgent) > calculate_pressure_score(milder)

    def test_postponing_always_lowers_the_score(self):
        """What a user means by "postpone". An hour is a nudge, a day is
        visible — but neither is ever zero change."""
        now = datetime.now(timezone.utc)
        overdue = calculate_pressure_score(make_task(due_at=now - timedelta(hours=2)))
        in_an_hour = calculate_pressure_score(make_task(due_at=now + timedelta(hours=1)))
        tomorrow = calculate_pressure_score(make_task(due_at=now + timedelta(days=1)))
        next_week = calculate_pressure_score(make_task(due_at=now + timedelta(days=7)))
        assert overdue > in_an_hour > tomorrow > next_week

    def test_score_is_never_negative(self):
        task = make_task(importance=1)
        score = calculate_pressure_score(task, dependency_count=0)
        assert score >= 0.0

    def test_no_pressure_on_fresh_low_importance_task(self):
        task = make_task(importance=1)
        score = calculate_pressure_score(task, dependency_count=0)
        # Only importance_weight contributes (1/2 = 0.5), which soft
        # saturation maps to a small positive number rather than passing
        # through unchanged. What matters is that a fresh, unimportant,
        # undated task sits near the bottom of the universe.
        assert 0.0 < score < 1.5

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
    extract_local_clock,
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

    def test_explicit_next_does_not_skip_a_week(self):
        # "next Friday" / "na proxima sexta" said on a Saturday means the
        # Friday six days away, not thirteen. Adding a week here was a
        # real bug: a task spoken for the coming Monday landed a week and
        # a half out.
        saturday = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
        got = resolve_weekday_date(saturday, 4, explicit_next=True)
        assert got.date() == date(2026, 9, 4)

    def test_explicit_next_skips_only_when_today_is_that_day(self):
        # Said ON a Saturday about Saturday, "next" plainly means the
        # following one.
        saturday = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
        assert resolve_weekday_date(saturday, 5, explicit_next=True).date() == date(2026, 9, 5)
        assert resolve_weekday_date(saturday, 5).date() == date(2026, 8, 29)

    def test_time_of_day_is_preserved(self):
        saturday = datetime(2026, 8, 29, 18, 30, tzinfo=timezone.utc)
        got = resolve_weekday_date(saturday, 0)
        assert (got.hour, got.minute) == (18, 30)


class TestPortugueseTranscriptForms:
    """Forms that appear in real Deepgram output, not in a dictionary.

    Both of these were found from a live capture that scheduled a Monday
    task for the following Friday at the wrong hour, because neither the
    weekday nor the clock pattern matched what was actually transcribed.
    """

    def test_run_together_weekday(self):
        # Deepgram writes spoken "segunda-feira" as one word.
        assert extract_weekday("na proxima segundafeira") == (0, True)
        assert extract_weekday("na sextafeira") == (4, False)
        assert extract_weekday("tercafeira") == (1, False)

    def test_hyphenated_and_bare_still_work(self):
        assert extract_weekday("proxima segunda-feira") == (0, True)
        assert extract_weekday("na sexta") == (4, False)

    def test_clock_prepositions_beyond_as(self):
        # "às" is not the only way Portuguese introduces a time.
        assert extract_local_clock("por volta das 9 da manha", language="pt-PT") == (9, 0)
        assert extract_local_clock("das 9 da manha", language="pt-PT") == (9, 0)
        assert extract_local_clock("pelas 9", language="pt-PT") == (9, 0)

    def test_part_of_day_still_applies(self):
        assert extract_local_clock("das 8 da noite", language="pt-PT") == (20, 0)

    def test_english_patterns_unaffected(self):
        assert extract_local_clock("at 8 pm") == (20, 0)
        assert extract_local_clock("at 20:30") == (20, 30)
