"""Tests for renewal warnings.

The schedule is the whole feature, and it is the part that cannot be checked
by hand without waiting four days. What is protected here is that the warning
arrives while the user can still act, and that it arrives once.
"""

from datetime import date, timedelta

import pytest

from app.services.membership_alerts import STAGES, should_send, stage_for

TODAY = date(2026, 9, 22)


# ---------------------------------------------------------------------------
# When each warning fires
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "days,expected",
    [
        (10, None),
        (5, None),
        (4, "d4"),
        (3, "d4"),
        (2, "d2"),
        (1, "d1"),
        (0, "d1"),
    ],
)
def test_the_ladder(days, expected):
    assert stage_for(TODAY + timedelta(days=days), TODAY) == expected


def test_nothing_is_said_about_a_renewal_that_already_happened():
    """The materialiser sends the receipt for those. A warning about a date
    in the past is just a wrong statement."""
    assert stage_for(date(2026, 9, 20), TODAY) is None


def test_a_day_three_renewal_still_gets_the_four_day_warning():
    """Ranges, not exact days. A sweep that only matched days == 4 would
    miss every rule created three days before its renewal, and miss
    everything after any outage."""
    assert stage_for(date(2026, 9, 25), TODAY) == "d4"


def test_the_nearest_stage_wins_after_an_outage():
    """If the server was down for a week, the useful message is "renews
    tomorrow", not "renews in four days"."""
    assert stage_for(date(2026, 9, 23), TODAY) == "d1"
    assert STAGES[0][1] == "d1", "stages must stay ordered nearest-first"


# ---------------------------------------------------------------------------
# Saying it once
# ---------------------------------------------------------------------------

OCCURRENCE = date(2026, 9, 24)


def test_a_fresh_occurrence_always_sends():
    assert should_send("d2", None, None, OCCURRENCE) is True


def test_the_same_stage_is_not_repeated():
    """The sweep runs hourly. Without this it would warn 24 times a day."""
    assert should_send("d2", "d2", OCCURRENCE.isoformat(), OCCURRENCE) is False


def test_the_ladder_still_advances():
    assert should_send("d1", "d2", OCCURRENCE.isoformat(), OCCURRENCE) is True


def test_it_never_steps_backwards():
    """A sweep deciding d2 is due must not overwrite a d1 already sent —
    which would then let d1 fire a second time."""
    assert should_send("d2", "d1", OCCURRENCE.isoformat(), OCCURRENCE) is False


def test_next_month_warns_again():
    """The bug this exists for: a rule that renewed yesterday carries last
    month's stage, and would look like it had already been warned about."""
    last_month = date(2026, 8, 24)
    assert should_send("d4", "renewed", last_month.isoformat(), OCCURRENCE) is True


def test_a_missing_date_is_treated_as_never_notified():
    assert should_send("d4", "d4", None, OCCURRENCE) is True
