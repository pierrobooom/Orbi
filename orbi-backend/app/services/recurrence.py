"""When a routine's periods fall — pure date arithmetic, no database, no AI.

A routine repeats daily, weekly, monthly or yearly, every N of those, from an
anchor date. This module answers two questions and nothing else:

    period_on(...)       the date of the nth period
    periods_to_create()  which periods should exist now, given what does

Keeping it free of I/O means the whole policy is tested against a frozen
clock, the way reminder_schedule.py is.

MONTH ENDS
Rent due on the 31st is due on the 30th in November and on the 28th (or 29th)
in February — and back on the 31st in March. Every period is computed from the
ANCHOR, never from the previous period, so one short month cannot drag every
later due date to the 28th.

WHY ONLY THE CURRENT PERIOD EXISTS
Periods are created shortly before they are due, one at a time. A year of
future bubbles would bury the universe, and editing a routine would mean
rewriting all of them. What is further ahead is computed when shown, never
stored.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FREQUENCIES = ("daily", "weekly", "monthly", "yearly")
ON_MISS = ("stay_overdue", "skip_ahead", "from_done")

# A period is created this many days before it is due, on top of any
# heads-up reminder the routine asks for. A week is enough to see it coming
# without a month of early bubbles.
BASE_LOOKAHEAD_DAYS = 7

# Guard for a server that was down a long time: at most this many missed
# periods are created in one pass. The next pass continues.
MAX_PER_PASS = 24


def _clamp_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _add_months(anchor: date, months: int) -> date:
    total = anchor.month - 1 + months
    return _clamp_day(anchor.year + total // 12, total % 12 + 1, anchor.day)


def period_on(anchor: date, frequency: str, interval: int, n: int) -> date:
    """The date of period n (0 = the anchor itself)."""
    if frequency == "daily":
        return anchor + timedelta(days=interval * n)
    if frequency == "weekly":
        return anchor + timedelta(weeks=interval * n)
    if frequency == "monthly":
        return _add_months(anchor, interval * n)
    if frequency == "yearly":
        return _add_months(anchor, 12 * interval * n)
    raise ValueError(f"unknown frequency {frequency!r}")


def first_index_on_or_after(anchor: date, frequency: str, interval: int, day: date) -> int:
    """The smallest n with period_on(n) >= day (0 if the anchor is already there)."""
    if day <= anchor:
        return 0
    # Divide by the LONGEST a period can be, so the estimate is never past
    # the answer, then step forward. Months and years vary in length, so no
    # single division is exact.
    longest = {"daily": 1, "weekly": 7, "monthly": 31, "yearly": 366}[frequency] * interval
    n = (day - anchor).days // longest
    while period_on(anchor, frequency, interval, n) < day:
        n += 1
    return n


def index_of(anchor: date, frequency: str, interval: int, day: date) -> int | None:
    """n such that period_on(n) == day, or None if day is not a period date."""
    n = first_index_on_or_after(anchor, frequency, interval, day)
    return n if period_on(anchor, frequency, interval, n) == day else None


def after_done(done_on: date, frequency: str, interval: int) -> date:
    """The next date for a from_done routine: one interval after it was done."""
    return period_on(done_on, frequency, interval, 1)


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "Europe/Lisbon")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("Europe/Lisbon")


def due_at(period: date, due_time: time, tz_name: str | None) -> datetime:
    """The UTC instant a period is due: its date at the routine's local time."""
    local = datetime.combine(period, due_time, tzinfo=zone(tz_name))
    return local.astimezone(timezone.utc)


def local_today(now: datetime, tz_name: str | None) -> date:
    return now.astimezone(zone(tz_name)).date()


@dataclass(frozen=True)
class Schedule:
    """The parts of a routine that decide its dates."""

    anchor_on: date
    frequency: str
    interval_count: int
    on_miss: str
    remind_before_days: int | None = None


@dataclass(frozen=True)
class OpenPeriod:
    period_on: date


def lookahead_days(schedule: Schedule) -> int:
    """How early a period is created: a week, plus any heads-up days."""
    return BASE_LOOKAHEAD_DAYS + (schedule.remind_before_days or 0)


def periods_to_create(
    schedule: Schedule,
    *,
    today: date,
    materialized_through: date | None,
    open_periods: list[OpenPeriod],
    last_done_on: date | None,
    starts_on: date,
) -> list[date]:
    """Which new periods should be created now, oldest first.

    Args:
        today:                the user's local date
        materialized_through: the latest period that already exists, if any
        open_periods:         periods not yet finished
        last_done_on:         local date the latest period was finished
                              (only from_done uses it)
        starts_on:            first day the routine applies — nothing before it
                              is ever created, so a routine set up in October
                              with a January anchor does not open nine months
                              of arrears

    The rules, per mode:
      - fixed schedules (stay_overdue, skip_ahead): walk the anchor's periods
        from the last one created. Missed periods are created too — for rent
        they are money still owed — but never more than one period that is
        still in the future.
      - from_done: one period at a time. The next date is one interval after
        the last was finished; until then nothing new is created.
    """
    window = today + timedelta(days=lookahead_days(schedule))

    if schedule.on_miss == "from_done":
        if open_periods:
            return []
        if materialized_through is None:
            candidate = schedule.anchor_on
        elif last_done_on is not None:
            candidate = after_done(last_done_on, schedule.frequency, schedule.interval_count)
        else:
            # Closed without a completion date — continue from the period.
            candidate = after_done(materialized_through, schedule.frequency, schedule.interval_count)
        if materialized_through is not None and candidate <= materialized_through:
            candidate = after_done(materialized_through, schedule.frequency, schedule.interval_count)
        return [candidate] if candidate <= window else []

    # Fixed schedules. A period still in the future already exists: wait.
    if any(p.period_on >= today for p in open_periods):
        return []

    if materialized_through is None:
        n = first_index_on_or_after(
            schedule.anchor_on, schedule.frequency, schedule.interval_count, starts_on
        )
    else:
        last = index_of(schedule.anchor_on, schedule.frequency, schedule.interval_count, materialized_through)
        if last is None:
            # The schedule changed since that period was made; continue from
            # the first new-schedule date after it.
            n = first_index_on_or_after(
                schedule.anchor_on, schedule.frequency, schedule.interval_count,
                materialized_through + timedelta(days=1),
            )
        else:
            n = last + 1

    created: list[date] = []
    while len(created) < MAX_PER_PASS:
        candidate = period_on(schedule.anchor_on, schedule.frequency, schedule.interval_count, n)
        if candidate > window:
            break
        created.append(candidate)
        if candidate >= today:
            break  # one future period at a time
        n += 1
    if schedule.on_miss == "skip_ahead" and len(created) > 1:
        # Missed periods of a skip_ahead routine are replaced, not owed.
        # Creating them only to skip them would flash bubbles and write rows
        # for weeks nobody will ever act on — only the newest is kept.
        return created[-1:]
    return created


def upcoming(schedule: Schedule, after: date, count: int = 1) -> list[date]:
    """The next `count` fixed-schedule dates strictly after `after`, for display."""
    n = first_index_on_or_after(
        schedule.anchor_on, schedule.frequency, schedule.interval_count, after + timedelta(days=1)
    )
    return [
        period_on(schedule.anchor_on, schedule.frequency, schedule.interval_count, n + i)
        for i in range(count)
    ]
