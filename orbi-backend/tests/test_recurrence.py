"""Routine dates: month ends, leap years, the three miss modes, time zones."""

from datetime import date, datetime, time, timezone

import pytest

from app.services.recurrence import (
    OpenPeriod,
    Schedule,
    after_done,
    due_at,
    first_index_on_or_after,
    index_of,
    period_on,
    periods_to_create,
    upcoming,
)


# ---------------------------------------------------------------------------
# Period dates
# ---------------------------------------------------------------------------

def test_rent_on_the_31st_follows_short_months_and_comes_back():
    """Computed from the anchor each time, so February does not drag every
    later month to the 28th."""
    anchor = date(2026, 1, 31)
    dates = [period_on(anchor, "monthly", 1, n) for n in range(4)]
    assert dates == [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]


def test_leap_day_in_a_leap_year_and_not_in_others():
    assert period_on(date(2027, 1, 29), "monthly", 1, 1) == date(2027, 2, 28)
    assert period_on(date(2028, 1, 29), "monthly", 1, 1) == date(2028, 2, 29)
    assert period_on(date(2028, 2, 29), "yearly", 1, 1) == date(2029, 2, 28)
    assert period_on(date(2028, 2, 29), "yearly", 1, 4) == date(2032, 2, 29)


def test_every_n_periods():
    assert period_on(date(2026, 1, 15), "monthly", 3, 1) == date(2026, 4, 15)  # quarterly
    assert period_on(date(2026, 1, 2), "weekly", 2, 3) == date(2026, 2, 13)
    assert period_on(date(2026, 1, 1), "daily", 1, 40) == date(2026, 2, 10)
    assert period_on(date(2026, 12, 15), "monthly", 1, 1) == date(2027, 1, 15)


@pytest.mark.parametrize("frequency,interval", [
    ("daily", 1), ("daily", 3), ("weekly", 1), ("weekly", 2),
    ("monthly", 1), ("monthly", 3), ("yearly", 1), ("yearly", 2),
])
def test_first_index_is_exact_for_every_day_of_two_years(frequency, interval):
    anchor = date(2026, 1, 31)
    day = anchor
    for _ in range(730):
        n = first_index_on_or_after(anchor, frequency, interval, day)
        assert period_on(anchor, frequency, interval, n) >= day
        assert n == 0 or period_on(anchor, frequency, interval, n - 1) < day
        day = date.fromordinal(day.toordinal() + 1)


def test_index_of_recognises_only_real_period_dates():
    anchor = date(2026, 1, 31)
    assert index_of(anchor, "monthly", 1, date(2026, 2, 28)) == 1
    assert index_of(anchor, "monthly", 1, date(2026, 2, 27)) is None


def test_after_done_counts_from_the_day_it_was_done():
    assert after_done(date(2026, 3, 12), "yearly", 1) == date(2027, 3, 12)
    assert after_done(date(2026, 3, 12), "monthly", 3) == date(2026, 6, 12)


def test_due_at_is_local_wall_clock_across_daylight_saving():
    # 09:00 in Lisbon is 08:00 UTC in summer and 09:00 UTC in winter.
    assert due_at(date(2026, 10, 15), time(9, 0), "Europe/Lisbon") == datetime(2026, 10, 15, 8, 0, tzinfo=timezone.utc)
    assert due_at(date(2026, 11, 15), time(9, 0), "Europe/Lisbon") == datetime(2026, 11, 15, 9, 0, tzinfo=timezone.utc)


def test_upcoming_dates_for_display():
    s = Schedule(date(2026, 1, 15), "monthly", 1, "stay_overdue")
    assert upcoming(s, date(2026, 10, 15), 2) == [date(2026, 11, 15), date(2026, 12, 15)]


# ---------------------------------------------------------------------------
# Which periods exist
# ---------------------------------------------------------------------------

RENT = Schedule(date(2026, 1, 15), "monthly", 1, "stay_overdue", remind_before_days=3)


def test_a_new_routine_does_not_open_months_of_arrears():
    """Set up on 1 October with a January anchor: October is the first period,
    not January to September."""
    created = periods_to_create(
        RENT, today=date(2026, 10, 1), materialized_through=None,
        open_periods=[], last_done_on=None, starts_on=date(2026, 10, 1),
    )
    assert created == []  # 15 Oct is 14 days away — beyond the 10-day window
    created = periods_to_create(
        RENT, today=date(2026, 10, 6), materialized_through=None,
        open_periods=[], last_done_on=None, starts_on=date(2026, 10, 1),
    )
    assert created == [date(2026, 10, 15)]


def test_a_period_appears_a_week_plus_the_heads_up_before_it_is_due():
    base = dict(materialized_through=date(2026, 10, 15), open_periods=[],
                last_done_on=None, starts_on=date(2026, 1, 1))
    assert periods_to_create(RENT, today=date(2026, 11, 4), **base) == []
    assert periods_to_create(RENT, today=date(2026, 11, 5), **base) == [date(2026, 11, 15)]


def test_unpaid_rent_stays_open_and_the_next_month_still_comes():
    created = periods_to_create(
        RENT, today=date(2026, 11, 6), materialized_through=date(2026, 10, 15),
        open_periods=[OpenPeriod(date(2026, 10, 15))], last_done_on=None,
        starts_on=date(2026, 1, 1),
    )
    assert created == [date(2026, 11, 15)]


def test_never_more_than_one_future_period():
    created = periods_to_create(
        RENT, today=date(2026, 11, 6), materialized_through=date(2026, 11, 15),
        open_periods=[OpenPeriod(date(2026, 11, 15))], last_done_on=None,
        starts_on=date(2026, 1, 1),
    )
    assert created == []


def test_after_downtime_missed_periods_are_created_up_to_the_next_future_one():
    created = periods_to_create(
        RENT, today=date(2027, 2, 10), materialized_through=date(2026, 10, 15),
        open_periods=[], last_done_on=None, starts_on=date(2026, 1, 1),
    )
    assert created == [date(2026, 11, 15), date(2026, 12, 15), date(2027, 1, 15), date(2027, 2, 15)]


def test_a_daily_chore_does_not_pile_up_a_week_of_bubbles():
    chore = Schedule(date(2026, 10, 1), "daily", 1, "skip_ahead")
    created = periods_to_create(
        chore, today=date(2026, 10, 10), materialized_through=date(2026, 10, 10),
        open_periods=[OpenPeriod(date(2026, 10, 10))], last_done_on=None,
        starts_on=date(2026, 10, 1),
    )
    assert created == []
    created = periods_to_create(
        chore, today=date(2026, 10, 11), materialized_through=date(2026, 10, 10),
        open_periods=[OpenPeriod(date(2026, 10, 10))], last_done_on=None,
        starts_on=date(2026, 10, 1),
    )
    assert created == [date(2026, 10, 11)]


def test_from_done_waits_for_completion_then_counts_from_it():
    vaccine = Schedule(date(2026, 3, 12), "yearly", 1, "from_done")
    # First period is the anchor the user gave.
    assert periods_to_create(vaccine, today=date(2026, 3, 6), materialized_through=None,
                             open_periods=[], last_done_on=None,
                             starts_on=date(2026, 3, 1)) == [date(2026, 3, 12)]
    # Still open: nothing new, however late.
    assert periods_to_create(vaccine, today=date(2026, 9, 1), materialized_through=date(2026, 3, 12),
                             open_periods=[OpenPeriod(date(2026, 3, 12))], last_done_on=None,
                             starts_on=date(2026, 3, 1)) == []
    # Done late, on 20 March: the next one is a year after THAT, and only
    # created as it comes near.
    assert periods_to_create(vaccine, today=date(2026, 9, 1), materialized_through=date(2026, 3, 12),
                             open_periods=[], last_done_on=date(2026, 3, 20),
                             starts_on=date(2026, 3, 1)) == []
    assert periods_to_create(vaccine, today=date(2027, 3, 14), materialized_through=date(2026, 3, 12),
                             open_periods=[], last_done_on=date(2026, 3, 20),
                             starts_on=date(2026, 3, 1)) == [date(2027, 3, 20)]


def test_a_changed_schedule_continues_after_the_last_period_made():
    """Rent moved from the 15th to the 1st after October was created."""
    moved = Schedule(date(2026, 11, 1), "monthly", 1, "stay_overdue")
    created = periods_to_create(
        moved, today=date(2026, 10, 25), materialized_through=date(2026, 10, 15),
        open_periods=[], last_done_on=None, starts_on=date(2026, 10, 20),
    )
    assert created == [date(2026, 11, 1)]


def test_skip_ahead_after_several_missed_weeks_creates_only_the_newest():
    chore = Schedule(date(2026, 10, 1), "weekly", 1, "skip_ahead")
    created = periods_to_create(
        chore, today=date(2026, 10, 20), materialized_through=date(2026, 10, 1),
        open_periods=[OpenPeriod(date(2026, 10, 1))], last_done_on=None,
        starts_on=date(2026, 10, 1),
    )
    assert created == [date(2026, 10, 22)]
