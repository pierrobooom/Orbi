"""Tests for who may connect a bank account.

This gate stands in front of the only feature in Orbi that costs money per
user per month. The failure that matters is not refusing someone who should
have access — they will say so — but letting someone through who should not,
because that arrives silently as an invoice.
"""

from uuid import UUID, uuid4

import pytest

from app.services.entitlements import ACCOUNT_LIMITS, check_bank_sync, feature_enabled

USER = UUID("e19d3f99-fbd4-45c3-a851-7be4254ee011")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("BANK_SYNC_ENABLED", raising=False)
    monkeypatch.delenv("BANK_SYNC_ALLOWLIST", raising=False)


# ---------------------------------------------------------------------------
# The switch
# ---------------------------------------------------------------------------

def test_off_by_default():
    """A feature that spends money per user per month must never arrive
    because an environment variable was forgotten."""
    assert feature_enabled() is False


def test_even_a_paying_subscriber_waits_while_the_feature_is_off():
    """The bill and the subscription are separate decisions. Until there are
    enough subscribers to clear the monthly floor, nobody connects — and the
    alternative would be pretending nobody had paid."""
    gate = check_bank_sync(uuid4(), "premium")
    assert gate.allowed is False
    assert gate.reason == "coming_soon"


def test_the_switch_turns_it_on(monkeypatch):
    monkeypatch.setenv("BANK_SYNC_ENABLED", "1")
    assert check_bank_sync(uuid4(), "pro").allowed is True


@pytest.mark.parametrize("value", ["1", "true", "yes"])
def test_truthy_spellings(monkeypatch, value):
    monkeypatch.setenv("BANK_SYNC_ENABLED", value)
    assert feature_enabled() is True


@pytest.mark.parametrize("value", ["0", "false", "", "no", "off"])
def test_anything_else_is_off(monkeypatch, value):
    monkeypatch.setenv("BANK_SYNC_ENABLED", value)
    assert feature_enabled() is False


# ---------------------------------------------------------------------------
# The allowlist
# ---------------------------------------------------------------------------

def test_an_allowlisted_user_connects_while_everyone_waits(monkeypatch):
    """Otherwise testing the feature would mean enabling the bill."""
    monkeypatch.setenv("BANK_SYNC_ALLOWLIST", str(USER))
    assert check_bank_sync(USER, "free").allowed is True
    assert check_bank_sync(uuid4(), "premium").reason == "coming_soon"


def test_the_allowlist_is_specific_people_not_a_prefix(monkeypatch):
    monkeypatch.setenv("BANK_SYNC_ALLOWLIST", str(USER))
    assert check_bank_sync(uuid4(), "premium").allowed is False


def test_whitespace_in_the_list_is_tolerated(monkeypatch):
    monkeypatch.setenv("BANK_SYNC_ALLOWLIST", f" {uuid4()} , {USER} ")
    assert check_bank_sync(USER, "free").allowed is True


# ---------------------------------------------------------------------------
# Tier and caps, once the feature is on
# ---------------------------------------------------------------------------

def test_free_is_told_to_upgrade(monkeypatch):
    monkeypatch.setenv("BANK_SYNC_ENABLED", "1")
    gate = check_bank_sync(uuid4(), "free")
    assert gate.allowed is False
    assert gate.reason == "upgrade"


def test_an_unknown_tier_is_treated_as_free(monkeypatch):
    """A malformed profile must never accidentally grant a paid feature."""
    monkeypatch.setenv("BANK_SYNC_ENABLED", "1")
    assert check_bank_sync(uuid4(), "legendary").reason == "upgrade"


@pytest.mark.parametrize("tier,limit", sorted(ACCOUNT_LIMITS.items()))
def test_the_cap_is_on_accounts_because_that_is_the_billed_unit(
    monkeypatch, tier, limit
):
    monkeypatch.setenv("BANK_SYNC_ENABLED", "1")
    assert check_bank_sync(uuid4(), tier, connected_accounts=limit - 1).allowed is True
    at_cap = check_bank_sync(uuid4(), tier, connected_accounts=limit)
    assert at_cap.allowed is False
    assert at_cap.reason == "limit"
    assert at_cap.limit == limit


def test_genius_gets_more_accounts_than_pro():
    assert ACCOUNT_LIMITS["premium"] > ACCOUNT_LIMITS["pro"]


# ---------------------------------------------------------------------------
# No provider
# ---------------------------------------------------------------------------

def test_no_provider_outranks_everything(monkeypatch):
    """Offering an upgrade to reach a feature this deployment does not have
    is worse than saying it is not there."""
    monkeypatch.setenv("BANK_SYNC_ENABLED", "1")
    monkeypatch.setenv("BANK_SYNC_ALLOWLIST", str(USER))
    gate = check_bank_sync(USER, "premium", provider_configured=False)
    assert gate.allowed is False
    assert gate.reason == "no_provider"
