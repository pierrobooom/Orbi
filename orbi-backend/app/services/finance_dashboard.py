"""Everything the Money dashboard shows, computed from stored entries.

ARITHMETIC, NOT AI
Every number here is a sum or a ratio over rows the user already owns. None
of it goes near a model, and that is deliberate: asking an LLM how much was
spent on subscriptions costs tokens to do a SUM() and occasionally gets it
wrong. The AI's job comes later and is a different one — reading these
numbers and saying something a person would not have noticed. It should
never be the thing that produces them.

WHY A MONTH IS NOT ENOUGH ON ITS OWN
"You spent 412 euros on groceries" is a fact without a meaning. Whether that
is good, bad or unremarkable depends entirely on what the previous months
looked like, so every figure here is paired with its own recent history and a
delta. A dashboard that cannot answer "is that a lot?" is a receipt.
"""

import logging
from collections import defaultdict
from datetime import date, datetime, timezone
from uuid import UUID

logger = logging.getLogger(__name__)

# How many months of history to compare against. Three is enough to show a
# direction without letting one unusual month dominate the baseline, and it
# keeps the query small for users who have barely any history.
COMPARISON_MONTHS = 3

# Below this, a percentage change is noise. A category that went from 2 to 4
# euros is "up 100%" and means nothing.
_MIN_MEANINGFUL = 5.0


def _month_key(value) -> str:
    return str(value)[:7]


def _shift_month(month: str, back: int) -> str:
    """The month `back` months before `month`, as YYYY-MM."""
    year, mon = int(month[:4]), int(month[5:7])
    total = year * 12 + (mon - 1) - back
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def build_dashboard(entries: list[dict], month: str) -> dict:
    """Summarise one month against the months before it.

    `entries` must cover the comparison window as well as the month itself —
    the caller fetches once and this slices, rather than issuing a query per
    month.
    """
    history_months = [_shift_month(month, i) for i in range(1, COMPARISON_MONTHS + 1)]

    this_month: list[dict] = []
    by_month: dict[str, list[dict]] = defaultdict(list)
    for entry in entries:
        key = _month_key(entry.get("entry_date"))
        if key == month:
            this_month.append(entry)
        elif key in history_months:
            by_month[key].append(entry)

    spend = sum(float(e["amount"]) for e in this_month if e["entry_type"] == "expense")
    income = sum(float(e["amount"]) for e in this_month if e["entry_type"] == "income")

    # Averaged over months that actually have data. Dividing by a fixed three
    # would halve the baseline for someone who has only used the app for two
    # months, making every category look like a dramatic increase.
    populated = [m for m in history_months if by_month.get(m)]
    baseline_spend = (
        sum(
            float(e["amount"])
            for m in populated
            for e in by_month[m]
            if e["entry_type"] == "expense"
        )
        / len(populated)
        if populated
        else 0.0
    )

    categories = _categories(this_month, by_month, populated)

    return {
        "month": month,
        "total_spend": round(spend, 2),
        "total_income": round(income, 2),
        "net": round(income - spend, 2),
        # None rather than 0 when there is no history: "no change" and "nothing
        # to compare against" are different answers and must look different.
        "average_spend": round(baseline_spend, 2) if populated else None,
        "spend_change_pct": _pct_change(spend, baseline_spend) if populated else None,
        "months_compared": len(populated),
        "categories": categories,
        "top_merchants": _top_merchants(this_month),
        "daily": _daily(this_month, month),
        "entry_count": len(this_month),
        "uncategorised_count": sum(
            1 for e in this_month
            if e["entry_type"] == "expense"
            and (e.get("category") or "uncategorized") == "uncategorized"
        ),
    }


def _pct_change(current: float, baseline: float) -> float | None:
    """Percentage change, or None when the baseline is too small to mean much."""
    if baseline < _MIN_MEANINGFUL:
        return None
    return round((current - baseline) / baseline * 100.0, 1)


def _categories(
    this_month: list[dict], by_month: dict[str, list[dict]], populated: list[str]
) -> list[dict]:
    """Per-category spend, each against its own average. Biggest first."""
    current: dict[str, float] = defaultdict(float)
    for entry in this_month:
        if entry["entry_type"] == "expense":
            current[entry.get("category") or "uncategorized"] += float(entry["amount"])

    history: dict[str, float] = defaultdict(float)
    for month_key in populated:
        for entry in by_month[month_key]:
            if entry["entry_type"] == "expense":
                history[entry.get("category") or "uncategorized"] += float(entry["amount"])

    divisor = len(populated) or 1
    total = sum(current.values()) or 1.0

    out = []
    for name, amount in current.items():
        average = history.get(name, 0.0) / divisor
        out.append(
            {
                "category": name,
                "amount": round(amount, 2),
                # Share of this month's spend, which is what a breakdown chart
                # actually draws.
                "share_pct": round(amount / total * 100.0, 1),
                "average": round(average, 2) if populated else None,
                "change_pct": _pct_change(amount, average) if populated else None,
            }
        )
    out.sort(key=lambda c: c["amount"], reverse=True)
    return out


def _top_merchants(this_month: list[dict], limit: int = 5) -> list[dict]:
    """Where the money actually went.

    Grouped by merchant rather than category because "Continente, 6 visits,
    142 euros" is something a person can act on, where "Groceries, 142" is
    only a label for money already spent.
    """
    totals: dict[str, float] = defaultdict(float)
    counts: dict[str, int] = defaultdict(int)
    for entry in this_month:
        if entry["entry_type"] != "expense":
            continue
        name = (entry.get("merchant") or "").strip() or "Unknown"
        totals[name] += float(entry["amount"])
        counts[name] += 1

    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return [
        {"merchant": name, "amount": round(amount, 2), "count": counts[name]}
        for name, amount in ranked
    ]


def _daily(this_month: list[dict], month: str) -> list[dict]:
    """Spend per day, with empty days included.

    Gaps are the point of a spending chart — a week of nothing followed by a
    large Saturday is the shape worth seeing, and omitting the zeroes would
    draw it as a smooth line.
    """
    totals: dict[str, float] = defaultdict(float)
    for entry in this_month:
        if entry["entry_type"] == "expense":
            totals[str(entry["entry_date"])[:10]] += float(entry["amount"])

    year, mon = int(month[:4]), int(month[5:7])
    from calendar import monthrange

    days = monthrange(year, mon)[1]
    today = datetime.now(timezone.utc).date()

    out = []
    for day in range(1, days + 1):
        current = date(year, mon, day)
        # Don't draw the rest of the month as a flat zero line — it reads as
        # "you stopped spending" rather than "it hasn't happened yet".
        if current > today:
            break
        key = current.isoformat()
        out.append({"date": key, "amount": round(totals.get(key, 0.0), 2)})
    return out
