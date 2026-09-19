"""Tests for recurring-transaction scheduling.

The schedule math is pure, so every awkward case — the 31st in February, a
leap day, a fortnightly rule crossing a month boundary, a server that was down
for a week — is testable against a frozen date with no database in sight.
"""

from datetime import date

import pytest

from app.services.recurring import (
    MAX_CATCHUP_OCCURRENCES,
    build_entry,
    next_occurrence,
    occurrences_due,
)


def make_rule(**overrides) -> dict:
    rule = {
        "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "owner_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "account_id": None,
        "merchant": "Netflix",
        "category": "Subscriptions",
        "amount": 12.99,
        "currency": "EUR",
        "entry_type": "expense",
        "notes": None,
        "cadence": "monthly",
        "interval_count": 1,
        "next_run_on": "2026-09-01",
        "end_on": None,
        "active": True,
    }
    rule.update(overrides)
    return rule


# ---------------------------------------------------------------------------
# Cadence arithmetic
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "current,cadence,interval,expected",
    [
        (date(2026, 9, 1), "weekly", 1, date(2026, 9, 8)),
        (date(2026, 9, 1), "weekly", 2, date(2026, 9, 15)),
        (date(2026, 9, 1), "monthly", 1, date(2026, 10, 1)),
        (date(2026, 9, 1), "monthly", 3, date(2026, 12, 1)),
        (date(2026, 12, 1), "monthly", 1, date(2027, 1, 1)),
        (date(2026, 9, 1), "yearly", 1, date(2027, 9, 1)),
    ],
)
def test_basic_cadences(current, cadence, interval, expected):
    assert next_occurrence(current, cadence, interval) == expected


def test_month_end_clamps_into_february_without_drifting():
    """A rule on the 31st must still fire in February, and must come back to
    the 31st in March. Clamping without an anchor walks the rule backwards a
    few days every February until it is nowhere near where it started."""
    feb = next_occurrence(date(2026, 1, 31), "monthly", 1, anchor_day=31)
    assert feb == date(2026, 2, 28)

    march = next_occurrence(feb, "monthly", 1, anchor_day=31)
    assert march == date(2026, 3, 31)


def test_leap_day_yearly_rule_survives_a_common_year():
    assert next_occurrence(date(2028, 2, 29), "yearly", 1, anchor_day=29) == date(
        2029, 2, 28
    )


def test_unknown_cadence_is_rejected_loudly():
    with pytest.raises(ValueError):
        next_occurrence(date(2026, 9, 1), "fortnightly", 1)


# ---------------------------------------------------------------------------
# What is owed
# ---------------------------------------------------------------------------

def test_nothing_due_before_the_first_run():
    due, next_run = occurrences_due(make_rule(next_run_on="2026-10-01"), date(2026, 9, 19))
    assert due == []
    assert next_run == date(2026, 10, 1)


def test_one_occurrence_when_exactly_due_today():
    due, next_run = occurrences_due(make_rule(next_run_on="2026-09-19"), date(2026, 9, 19))
    assert [o.on for o in due] == [date(2026, 9, 19)]
    assert next_run == date(2026, 10, 19)


def test_downtime_is_caught_up_not_skipped():
    """A rule due on the 1st, on a server down until the 5th, still owes the
    1st's entry. Jumping to the next future date would silently lose a month
    of rent."""
    due, next_run = occurrences_due(
        make_rule(cadence="weekly", next_run_on="2026-09-01"), date(2026, 9, 25)
    )
    assert [o.on for o in due] == [
        date(2026, 9, 1),
        date(2026, 9, 8),
        date(2026, 9, 15),
        date(2026, 9, 22),
    ]
    assert next_run == date(2026, 9, 29)


def test_catch_up_is_bounded():
    """A rule created with a start date years ago must not generate a decade
    of entries and a very surprised user."""
    due, _ = occurrences_due(
        make_rule(cadence="monthly", next_run_on="2015-01-01"), date(2026, 9, 19)
    )
    assert len(due) == MAX_CATCHUP_OCCURRENCES


def test_end_date_stops_the_rule():
    """A 12-month contract should not bill forever. next_run of None is the
    signal to deactivate, rather than a sentinel date a caller could reschedule
    against by accident."""
    due, next_run = occurrences_due(
        make_rule(cadence="monthly", next_run_on="2026-09-01", end_on="2026-10-15"),
        date(2026, 12, 1),
    )
    assert [o.on for o in due] == [date(2026, 9, 1), date(2026, 10, 1)]
    assert next_run is None


def test_inactive_rule_produces_nothing():
    due, _ = occurrences_due(make_rule(active=False), date(2026, 12, 1))
    assert due == []


def test_rule_with_no_start_date_is_inert():
    due, next_run = occurrences_due(make_rule(next_run_on=None), date(2026, 9, 19))
    assert due == []
    assert next_run is None


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

def test_external_ids_are_deterministic_per_date():
    """The whole idempotency guarantee. A rule that fires twice for the same
    date — a retry, two workers, a manual run — must produce the same id so
    the unique index absorbs the duplicate."""
    rule = make_rule(next_run_on="2026-09-01")
    first, _ = occurrences_due(rule, date(2026, 9, 19))
    second, _ = occurrences_due(rule, date(2026, 9, 19))
    assert [o.external_id for o in first] == [o.external_id for o in second]


def test_external_ids_differ_between_occurrences():
    due, _ = occurrences_due(
        make_rule(cadence="weekly", next_run_on="2026-09-01"), date(2026, 9, 19)
    )
    assert len({o.external_id for o in due}) == len(due)


def test_built_entry_carries_the_source_and_the_dedupe_key():
    rule = make_rule(next_run_on="2026-09-19")
    due, _ = occurrences_due(rule, date(2026, 9, 19))
    entry = build_entry(rule, due[0])

    assert entry["source_type"] == "recurring"
    assert entry["external_id"] == due[0].external_id
    assert entry["entry_date"] == "2026-09-19"
    assert entry["merchant"] == "Netflix"
    assert entry["amount"] == 12.99
