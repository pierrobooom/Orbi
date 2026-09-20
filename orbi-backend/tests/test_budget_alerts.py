"""Tests for spending-limit alerting.

The decision half is pure — rows in, decisions out — so the rule that makes
this bearable to live with (say it once, not once an hour for three weeks) is
testable against fixed data rather than by watching whether a phone buzzes
twice.
"""

from app.services.budget_alerts import evaluate_budgets

MONTH = "2026-09"


def budget(**overrides) -> dict:
    row = {
        "id": "b1",
        "user_id": "u1",
        "category": "groceries",
        "monthly_limit": 200.0,
        "alert_threshold": 0.8,
        "alerts_enabled": True,
        "notified_level": None,
        "notified_period": None,
    }
    row.update(overrides)
    return row


def spend(amount: float, category="groceries", month=MONTH, kind="expense") -> dict:
    return {
        "entry_date": f"{month}-05",
        "amount": amount,
        "category": category,
        "entry_type": kind,
    }


# ---------------------------------------------------------------------------
# When an alert is owed
# ---------------------------------------------------------------------------

def test_nothing_below_the_threshold():
    due = evaluate_budgets([budget()], [spend(100.0)], MONTH)
    assert due == []


def test_warns_once_the_threshold_is_crossed():
    """A limit is useful BEFORE it is hit — while there is still something to
    decide."""
    due = evaluate_budgets([budget()], [spend(170.0)], MONTH)
    assert len(due) == 1
    assert due[0]["kind"] == "warn"
    assert due[0]["spent"] == 170.0


def test_exceeding_reports_over_not_warn():
    """"You're close" and "you've gone past" call for different reactions, so
    landing straight past the limit must not produce the gentler message."""
    due = evaluate_budgets([budget()], [spend(250.0)], MONTH)
    assert due[0]["kind"] == "over"
    assert due[0]["level"] == 1.0


def test_a_custom_threshold_is_respected():
    due = evaluate_budgets([budget(alert_threshold=0.5)], [spend(120.0)], MONTH)
    assert due[0]["kind"] == "warn"


# ---------------------------------------------------------------------------
# Saying it once — the rule that decides whether this feature is tolerable
# ---------------------------------------------------------------------------

def test_a_warning_is_not_repeated():
    """The sweep runs hourly. Without this it would warn every hour for the
    rest of the month, and the user would turn notifications off entirely —
    after which nothing can be told to them at all."""
    already = budget(notified_level=0.8, notified_period=MONTH)
    assert evaluate_budgets([already], [spend(170.0)], MONTH) == []


def test_exceeding_still_fires_after_a_warning():
    """Storing the LEVEL rather than a boolean is what allows a second,
    different message when the limit is actually passed."""
    warned = budget(notified_level=0.8, notified_period=MONTH)
    due = evaluate_budgets([warned], [spend(250.0)], MONTH)
    assert len(due) == 1
    assert due[0]["kind"] == "over"


def test_nothing_fires_twice_after_exceeding():
    over = budget(notified_level=1.0, notified_period=MONTH)
    assert evaluate_budgets([over], [spend(400.0)], MONTH) == []


def test_a_new_month_resets_alerting():
    """notified_period is what makes that free — no scheduled job to clear
    flags, and nothing to go wrong if such a job failed to run."""
    last_month = budget(notified_level=1.0, notified_period="2026-08")
    due = evaluate_budgets([last_month], [spend(250.0)], MONTH)
    assert len(due) == 1


# ---------------------------------------------------------------------------
# What is counted
# ---------------------------------------------------------------------------

def test_only_this_month_counts_toward_a_limit():
    entries = [spend(250.0, month="2026-08"), spend(50.0)]
    assert evaluate_budgets([budget()], entries, MONTH) == []


def test_income_does_not_consume_a_spending_limit():
    entries = [spend(50.0), spend(900.0, kind="income")]
    assert evaluate_budgets([budget()], entries, MONTH) == []


def test_other_categories_do_not_consume_a_limit():
    entries = [spend(50.0), spend(500.0, category="transport")]
    assert evaluate_budgets([budget()], entries, MONTH) == []


# ---------------------------------------------------------------------------
# Not being a nuisance
# ---------------------------------------------------------------------------

def test_disabled_alerts_stay_silent():
    """Keeping a limit for tracking without being told about it is a
    different wish from deleting the limit."""
    off = budget(alerts_enabled=False)
    assert evaluate_budgets([off], [spend(500.0)], MONTH) == []


def test_trivial_limits_are_ignored():
    """A 5-euro limit crossed by 50 cents is "10% over" and not worth
    interrupting anyone for."""
    tiny = budget(monthly_limit=5.0)
    assert evaluate_budgets([tiny], [spend(50.0)], MONTH) == []


def test_a_zero_limit_does_not_divide_by_zero():
    assert evaluate_budgets([budget(monthly_limit=0)], [spend(10.0)], MONTH) == []


def test_several_budgets_are_evaluated_independently():
    budgets = [
        budget(id="b1", category="groceries", monthly_limit=200.0),
        budget(id="b2", category="transport", monthly_limit=100.0),
    ]
    entries = [spend(190.0), spend(20.0, category="transport")]
    due = evaluate_budgets(budgets, entries, MONTH)
    assert [d["category"] for d in due] == ["groceries"]
