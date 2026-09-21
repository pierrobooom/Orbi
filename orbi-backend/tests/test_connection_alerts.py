"""Tests for bank-connection expiry warnings.

The whole feature is one decision — does this connection owe the user a
message, and which one — so that is what is tested. What is being protected
here is mostly restraint: not nagging, not crying wolf over a transient
provider error, and not warning on a date nobody gave us.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.bank_sync import _consent_has_lapsed
from app.services.connection_alerts import WARNING_DAYS, classify, describe_when

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)


def connection(**overrides) -> dict:
    base = {
        "id": "c1",
        "owner_id": "u1",
        "account_id": "a1",
        "status": "active",
        "consent_expires_at": (NOW + timedelta(days=60)).isoformat(),
        "notified_state": None,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Warning while there is still time to act
# ---------------------------------------------------------------------------

def test_a_healthy_consent_says_nothing():
    assert classify(connection(), NOW) is None


def test_warns_inside_the_window():
    expires = NOW + timedelta(days=WARNING_DAYS - 1)
    assert classify(connection(consent_expires_at=expires.isoformat()), NOW) == "expiring"


def test_does_not_warn_twice_about_the_same_consent():
    """An hourly sweep re-reads the same row every hour. Saying it again each
    time is how a user turns notifications off entirely."""
    expires = NOW + timedelta(days=2)
    row = connection(consent_expires_at=expires.isoformat(), notified_state="expiring")
    assert classify(row, NOW) is None


# ---------------------------------------------------------------------------
# After it has stopped
# ---------------------------------------------------------------------------

def test_an_expired_connection_is_reported():
    assert classify(connection(status="expired"), NOW) == "dead"


def test_the_death_notice_still_fires_after_an_earlier_warning():
    """The two messages ask for different things: one is a chance to prevent
    the outage, the other is news that the totals now have a hole."""
    row = connection(status="expired", notified_state="expiring")
    assert classify(row, NOW) == "dead"


def test_the_death_notice_is_not_repeated():
    row = connection(status="expired", notified_state="dead")
    assert classify(row, NOW) is None


def test_a_lapsed_date_counts_as_dead_even_if_the_status_is_stale():
    """The sweep runs hourly; the sync runs daily. Between them a connection
    sits past its expiry still marked active."""
    expires = NOW - timedelta(hours=3)
    assert classify(connection(consent_expires_at=expires.isoformat()), NOW) == "dead"


# ---------------------------------------------------------------------------
# Not crying wolf
# ---------------------------------------------------------------------------

def test_a_provider_error_is_not_a_reconnect_prompt():
    """'error' is retried on its own. Telling someone to go through bank
    re-authentication over a transient 500 teaches them to ignore the
    message that actually matters."""
    assert classify(connection(status="error"), NOW) is None


def test_a_pending_connection_has_nothing_to_lose():
    assert classify(connection(status="pending"), NOW) is None


def test_no_stated_expiry_means_no_guessing():
    """Some providers omit it. Inventing a date would send people to their
    bank for no reason."""
    assert classify(connection(consent_expires_at=None), NOW) is None


def test_an_unparseable_expiry_does_not_warn():
    assert classify(connection(consent_expires_at="soon"), NOW) is None


# ---------------------------------------------------------------------------
# The copy
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "days,expected",
    [(0, "today"), (1, "tomorrow"), (5, "in 5 days")],
)
def test_when_is_relative_not_a_timestamp(days, expected):
    """A date needs mental arithmetic before it becomes urgency, and the
    point of an early warning is that the user acts now."""
    assert describe_when(NOW + timedelta(days=days), NOW, "en") == expected


def test_portuguese_copy_is_used_for_portuguese_users():
    assert describe_when(NOW + timedelta(days=1), NOW, "pt-pt") == "amanhã"


# ---------------------------------------------------------------------------
# Not paying to discover a dead consent
# ---------------------------------------------------------------------------

def test_a_lapsed_consent_is_detected_without_calling_the_provider():
    """Every provider call is metered. Spending one a day per account to be
    told what the expiry date already says is a bill for nothing."""
    assert _consent_has_lapsed(
        {"consent_expires_at": (NOW - timedelta(minutes=1)).isoformat()}, NOW
    )


def test_a_live_consent_is_not_skipped():
    assert not _consent_has_lapsed(
        {"consent_expires_at": (NOW + timedelta(days=1)).isoformat()}, NOW
    )


def test_a_missing_expiry_never_blocks_a_sync():
    """"Don't know" must read as not-lapsed, or every provider that omits the
    field would stop syncing entirely."""
    assert not _consent_has_lapsed({}, NOW)
    assert not _consent_has_lapsed({"consent_expires_at": "whenever"}, NOW)
