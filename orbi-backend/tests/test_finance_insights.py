"""Tests for spending insights.

The deterministic half and the regeneration window are pure, so both are
testable without a model. What is checked here is mostly restraint: not
saying things with no basis, not saying the same thing twice, and not
spending an AI call because a screen was opened.
"""

from datetime import datetime, timedelta, timezone

from app.services.finance_insights import (
    MIN_HOURS_BETWEEN_GENERATIONS,
    _facts_for_model,
    deterministic_insights,
    should_regenerate,
)


def dashboard(**overrides) -> dict:
    base = {
        "month": "2026-09",
        "total_spend": 500.0,
        "total_income": 1000.0,
        "net": 500.0,
        "average_spend": 450.0,
        "spend_change_pct": 11.1,
        "months_compared": 3,
        "categories": [],
        "top_merchants": [],
        "daily": [],
        "entry_count": 12,
        "uncategorised_count": 0,
    }
    base.update(overrides)
    return base


def category(name="dining", amount=100.0, average=50.0, change=100.0, share=20.0) -> dict:
    return {
        "category": name,
        "amount": amount,
        "share_pct": share,
        "average": average,
        "change_pct": change,
    }


# ---------------------------------------------------------------------------
# Only saying things that have a basis
# ---------------------------------------------------------------------------

def test_no_trend_claim_without_history():
    """"Dining is above your usual" said to someone in their first month is
    a fabrication — there is no usual yet."""
    data = dashboard(
        months_compared=0,
        categories=[category(average=None, change=None)],
    )
    assert deterministic_insights(data, []) == []


def test_a_large_rise_is_reported_with_both_numbers():
    data = dashboard(categories=[category(amount=200.0, average=80.0, change=150.0)])
    out = deterministic_insights(data, [])
    assert len(out) == 1
    assert "200.00" in out[0]["insight_text"]
    assert "80.00" in out[0]["insight_text"]
    assert out[0]["severity"] == "warning"


def test_a_modest_rise_is_not_worth_saying():
    """Every category drifts. Reporting a 20% move would bury the one that
    matters under four that do not."""
    data = dashboard(categories=[category(amount=60.0, average=50.0, change=20.0)])
    assert deterministic_insights(data, []) == []


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

def test_an_approaching_limit_names_what_is_left():
    limits = [
        {
            "category": "dining",
            "monthly_limit": 150.0,
            "spent": 110.0,
            "remaining": 40.0,
            "fraction": 0.73,
        }
    ]
    out = deterministic_insights(dashboard(), limits)
    assert "40.00" in out[0]["insight_text"]


def test_an_already_exceeded_limit_is_left_to_the_alert():
    """The sweep has already sent a notification about it. Repeating it in a
    list is the same message twice."""
    limits = [
        {
            "category": "dining",
            "monthly_limit": 150.0,
            "spent": 200.0,
            "remaining": -50.0,
            "fraction": 1.33,
        }
    ]
    assert deterministic_insights(dashboard(), limits) == []


def test_a_comfortable_limit_says_nothing():
    limits = [
        {
            "category": "dining",
            "monthly_limit": 150.0,
            "spent": 20.0,
            "remaining": 130.0,
            "fraction": 0.13,
        }
    ]
    assert deterministic_insights(dashboard(), limits) == []


# ---------------------------------------------------------------------------
# Merchants and gaps
# ---------------------------------------------------------------------------

def test_a_dominant_merchant_is_worth_pointing_out():
    """A category says what kind of spending; a merchant says where to
    actually change something."""
    data = dashboard(
        total_spend=300.0,
        top_merchants=[{"merchant": "Uber Eats", "amount": 120.0, "count": 6}],
    )
    out = deterministic_insights(data, [])
    assert any("Uber Eats" in i["insight_text"] for i in out)
    assert out[0]["subject"] == "Uber Eats"


def test_a_single_large_purchase_is_not_a_pattern():
    """One transaction at 40% of the month is a laptop, not a habit."""
    data = dashboard(
        total_spend=300.0,
        top_merchants=[{"merchant": "Worten", "amount": 120.0, "count": 1}],
    )
    assert deterministic_insights(data, []) == []


def test_uncategorised_spending_is_flagged_as_undermining_the_rest():
    data = dashboard(uncategorised_count=9)
    out = deterministic_insights(data, [])
    assert any("category" in i["insight_text"] for i in out)


def test_a_couple_of_uncategorised_rows_are_not_worth_a_nag():
    assert deterministic_insights(dashboard(uncategorised_count=2), []) == []


# ---------------------------------------------------------------------------
# What the model is given
# ---------------------------------------------------------------------------

def test_the_prompt_gets_computed_figures_not_transactions():
    """Sending a month of rows would cost a great deal, invite the model to
    do arithmetic it is bad at, and put a full spending history through a
    third party for no gain."""
    facts = _facts_for_model(
        dashboard(categories=[category()]),
        [{"category": "dining", "monthly_limit": 150.0, "spent": 110.0}],
    )
    assert "total_spend" in facts
    assert "entry_date" not in facts
    assert "merchant" not in facts or "top_merchants" in facts
    # Compact enough that an insight costs a trivial number of tokens.
    assert len(facts) < 3000


# ---------------------------------------------------------------------------
# Not spending money on every screen open
# ---------------------------------------------------------------------------

def test_first_run_generates():
    assert should_regenerate(None) is True


def test_a_recent_generation_blocks_another():
    """A screen that regenerated on every open would be the largest line on
    the bill, and two views an hour apart would not differ."""
    recent = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert should_regenerate(recent) is False


def test_regenerates_once_the_window_has_passed():
    old = (
        datetime.now(timezone.utc)
        - timedelta(hours=MIN_HOURS_BETWEEN_GENERATIONS + 1)
    ).isoformat()
    assert should_regenerate(old) is True


def test_an_unparseable_timestamp_does_not_block_forever():
    assert should_regenerate("not-a-date") is True
