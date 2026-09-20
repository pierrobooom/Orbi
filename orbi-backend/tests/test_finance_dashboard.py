"""Tests for the dashboard figures.

All arithmetic over the user's own rows, so all testable without a database,
a network or a model. The cases here are the ones where a plausible-looking
number would be actively misleading — a baseline halved by missing history, a
percentage computed off three euros, a chart that draws the future as zero.
"""

from datetime import date, datetime, timedelta, timezone

from app.services.finance_dashboard import (
    COMPARISON_MONTHS,
    _pct_change,
    _shift_month,
    build_dashboard,
)

THIS_MONTH = "2026-09"


def entry(day: str, amount: float, category="groceries", kind="expense", merchant="Shop"):
    return {
        "entry_date": day,
        "amount": amount,
        "category": category,
        "entry_type": kind,
        "merchant": merchant,
    }


# ---------------------------------------------------------------------------
# Month arithmetic
# ---------------------------------------------------------------------------

def test_shift_month_crosses_a_year_boundary():
    assert _shift_month("2026-01", 1) == "2025-12"
    assert _shift_month("2026-01", 3) == "2025-10"
    assert _shift_month("2026-09", 0) == "2026-09"


# ---------------------------------------------------------------------------
# Totals
# ---------------------------------------------------------------------------

def test_totals_separate_spend_from_income():
    data = [
        entry("2026-09-02", 40.0),
        entry("2026-09-03", 10.0),
        entry("2026-09-04", 1800.0, kind="income", merchant="Salary"),
    ]
    result = build_dashboard(data, THIS_MONTH)
    assert result["total_spend"] == 50.0
    assert result["total_income"] == 1800.0
    assert result["net"] == 1750.0


def test_other_months_are_excluded_from_the_total():
    data = [entry("2026-09-02", 40.0), entry("2026-08-02", 999.0)]
    assert build_dashboard(data, THIS_MONTH)["total_spend"] == 40.0


# ---------------------------------------------------------------------------
# The comparison, which is what makes a number mean anything
# ---------------------------------------------------------------------------

def test_no_history_reports_none_rather_than_zero():
    """"No change" and "nothing to compare against" are different answers and
    must not render identically — a first-month user would otherwise be told
    every category is flat."""
    result = build_dashboard([entry("2026-09-02", 40.0)], THIS_MONTH)
    assert result["average_spend"] is None
    assert result["spend_change_pct"] is None
    assert result["months_compared"] == 0


def test_baseline_averages_only_months_that_have_data():
    """Dividing by a fixed three would halve the baseline for someone two
    months in, making every category look like a dramatic increase."""
    data = [
        entry("2026-09-02", 100.0),
        entry("2026-08-02", 100.0),  # one month of history, not three
    ]
    result = build_dashboard(data, THIS_MONTH)
    assert result["months_compared"] == 1
    assert result["average_spend"] == 100.0
    assert result["spend_change_pct"] == 0.0


def test_spend_change_is_computed_against_the_average():
    data = [
        entry("2026-09-02", 150.0),
        entry("2026-08-02", 100.0),
        entry("2026-07-02", 100.0),
    ]
    result = build_dashboard(data, THIS_MONTH)
    assert result["average_spend"] == 100.0
    assert result["spend_change_pct"] == 50.0


def test_percentages_off_a_tiny_baseline_are_suppressed():
    """2 euros to 4 euros is "up 100%" and means nothing. Reporting it would
    fill the dashboard with alarming noise about pocket change."""
    assert _pct_change(4.0, 2.0) is None
    assert _pct_change(150.0, 100.0) == 50.0


def test_history_beyond_the_window_is_ignored():
    old = _shift_month(THIS_MONTH, COMPARISON_MONTHS + 2)
    data = [entry("2026-09-02", 50.0), entry(f"{old}-02", 5000.0)]
    result = build_dashboard(data, THIS_MONTH)
    assert result["months_compared"] == 0


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------

def test_categories_are_ranked_by_amount_with_shares():
    data = [
        entry("2026-09-02", 75.0, category="groceries"),
        entry("2026-09-03", 25.0, category="transport"),
    ]
    cats = build_dashboard(data, THIS_MONTH)["categories"]
    assert [c["category"] for c in cats] == ["groceries", "transport"]
    assert cats[0]["share_pct"] == 75.0
    assert cats[1]["share_pct"] == 25.0


def test_income_is_not_a_spending_category():
    data = [
        entry("2026-09-02", 50.0, category="groceries"),
        entry("2026-09-03", 900.0, category="finance", kind="income"),
    ]
    cats = build_dashboard(data, THIS_MONTH)["categories"]
    assert [c["category"] for c in cats] == ["groceries"]


def test_uncategorised_spending_is_counted_so_it_can_be_prompted():
    data = [
        entry("2026-09-02", 10.0, category="uncategorized"),
        entry("2026-09-03", 10.0, category="groceries"),
    ]
    assert build_dashboard(data, THIS_MONTH)["uncategorised_count"] == 1


# ---------------------------------------------------------------------------
# Merchants
# ---------------------------------------------------------------------------

def test_top_merchants_aggregate_visits():
    """"Continente, 3 visits, 142" is actionable where "Groceries, 142" is
    only a label for money already gone."""
    data = [
        entry("2026-09-02", 50.0, merchant="Continente"),
        entry("2026-09-05", 60.0, merchant="Continente"),
        entry("2026-09-06", 32.0, merchant="Continente"),
        entry("2026-09-07", 90.0, merchant="Galp"),
    ]
    top = build_dashboard(data, THIS_MONTH)["top_merchants"]
    assert top[0] == {"merchant": "Continente", "amount": 142.0, "count": 3}
    assert top[1]["merchant"] == "Galp"


# ---------------------------------------------------------------------------
# The daily series
# ---------------------------------------------------------------------------

def test_daily_series_includes_empty_days():
    """Gaps are the point of a spending chart — a quiet week then a big
    Saturday is the shape worth seeing, and omitting zeroes draws a smooth
    line that hides it."""
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    first = f"{month}-01"
    daily = build_dashboard([entry(first, 20.0)], month)["daily"]
    assert daily[0] == {"date": first, "amount": 20.0}
    if len(daily) > 1:
        assert daily[1]["amount"] == 0.0


def test_daily_series_stops_at_today():
    """Drawing the rest of the month as a flat zero line reads as "you
    stopped spending" rather than "it hasn't happened yet"."""
    today = datetime.now(timezone.utc).date()
    month = today.strftime("%Y-%m")
    daily = build_dashboard([entry(today.isoformat(), 5.0)], month)["daily"]
    assert daily[-1]["date"] == today.isoformat()
    assert len(daily) == today.day
