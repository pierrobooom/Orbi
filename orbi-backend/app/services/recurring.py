"""Recurring transactions — the predictable half of a month's spending.

Rent, the gym, Netflix, the phone bill. Typing these in every month is the
dullest thing a finance app can ask of anyone and the usual reason people stop
using one. A rule states them once; this materialises them.

PURE SCHEDULE MATH, SEPARATE FROM THE WRITING
`next_occurrence` is a pure function of a date and a cadence, so every awkward
case — the 31st in February, a leap day, a fortnightly rule crossing a month
boundary — is unit-testable against a frozen clock with no database in sight.

CATCH-UP IS DELIBERATE AND BOUNDED
A rule due on the 1st, on a server that was down until the 5th, must still
produce the 1st's entry. So materialisation loops until the schedule catches up
with today rather than simply jumping to the next future date. It is bounded,
because a rule created with a next_run_on of 2015 would otherwise generate a
decade of entries and a very surprised user.
"""

import logging
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta

logger = logging.getLogger(__name__)

# How many occurrences one rule may produce in a single catch-up pass. Two
# years of monthly, or a year of fortnightly — comfortably more than any real
# outage, comfortably less than a runaway.
MAX_CATCHUP_OCCURRENCES = 24


@dataclass(frozen=True)
class Occurrence:
    """One entry a rule says should exist, before it is written."""

    on: date
    # Deterministic, and the deduplication key. A rule firing twice for the
    # same date — a retry, an overlapping worker, a manual "run now" — must
    # produce the same id so the unique index absorbs the second one.
    external_id: str


def _clamp_day(year: int, month: int, day: int) -> date:
    """The given day of that month, or the last day if it is short.

    A rule set to the 31st must still fire in February. Clamping forward to
    March 1st would drift the rule permanently; clamping to the 28th keeps it
    anchored, which is what "the 31st of every month" means to a person paying
    rent.
    """
    last = monthrange(year, month)[1]
    return date(year, month, min(day, last))


def _add_months(anchor: date, months: int, day_of_month: int) -> date:
    total = anchor.month - 1 + months
    year = anchor.year + total // 12
    month = total % 12 + 1
    return _clamp_day(year, month, day_of_month)


def next_occurrence(
    current: date, cadence: str, interval_count: int = 1, anchor_day: int | None = None
) -> date:
    """The date after `current` for this schedule.

    `anchor_day` preserves the original day-of-month across short months: a
    rule anchored on the 31st that fired on Feb 28 must go to Mar 31, not
    Mar 28. Without it, every February permanently walks the rule backwards.
    """
    interval = max(1, interval_count)
    if cadence == "weekly":
        return current + timedelta(weeks=interval)
    if cadence == "monthly":
        return _add_months(current, interval, anchor_day or current.day)
    if cadence == "yearly":
        day = anchor_day or current.day
        try:
            return current.replace(year=current.year + interval, day=day)
        except ValueError:
            # Feb 29 in a non-leap year.
            return _clamp_day(current.year + interval, current.month, day)
    raise ValueError(f"Unknown cadence: {cadence!r}")


def occurrences_due(
    rule: dict, today: date, max_occurrences: int = MAX_CATCHUP_OCCURRENCES
) -> tuple[list[Occurrence], date | None]:
    """Every occurrence owed up to today, and where the schedule lands next.

    Returns (occurrences, next_run_on). A next_run_on of None means the rule
    has passed its end date and should be deactivated — expressed as None
    rather than a sentinel date so the caller cannot accidentally reschedule a
    finished rule.
    """
    if not rule.get("active", True):
        return [], _parse_date(rule.get("next_run_on"))

    cursor = _parse_date(rule.get("next_run_on"))
    if cursor is None:
        return [], None

    cadence = str(rule.get("cadence") or "monthly")
    interval = int(rule.get("interval_count") or 1)
    end_on = _parse_date(rule.get("end_on"))
    # The day the user actually chose, so short months don't erode it.
    anchor_day = cursor.day
    rule_id = str(rule.get("id"))

    due: list[Occurrence] = []
    while cursor <= today and len(due) < max_occurrences:
        if end_on and cursor > end_on:
            return due, None
        due.append(Occurrence(on=cursor, external_id=f"recurring:{rule_id}:{cursor.isoformat()}"))
        try:
            cursor = next_occurrence(cursor, cadence, interval, anchor_day)
        except ValueError:
            logger.warning("Rule %s has an unknown cadence %r", rule_id, cadence)
            return due, None

    if end_on and cursor > end_on:
        return due, None
    return due, cursor


def build_entry(rule: dict, occurrence: Occurrence) -> dict:
    """The finance_entries row for one occurrence."""
    return {
        "user_id": str(rule["owner_id"]),
        "account_id": str(rule["account_id"]) if rule.get("account_id") else None,
        "amount": float(rule["amount"]),
        "currency": rule.get("currency") or "EUR",
        "merchant": rule["merchant"],
        "category": rule["category"],
        "entry_type": rule["entry_type"],
        "entry_date": occurrence.on.isoformat(),
        "source_type": "recurring",
        "external_id": occurrence.external_id,
        "notes": rule.get("notes"),
    }


def _parse_date(value) -> date | None:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None
