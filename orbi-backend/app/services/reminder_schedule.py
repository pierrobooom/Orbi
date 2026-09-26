"""When to remind someone about a task — pure, deterministic, no AI.

This module is the answer to "when should this fire?" and nothing else. It
touches no database, makes no network call, and has no side effects, so the
whole reminder policy can be unit-tested against a frozen clock.

WHY NOT THE LLM
agents/reminder_planner.py asks Groq to pick the times, feeding it up to 50
tasks per run. That is the wrong tool three times over: it costs tokens on a
job that is arithmetic, it returns a different answer for the same task on
two consecutive days, and the copy it writes would need translating for every
language the app supports. Timing is computed here; wording comes from
templates the client already localises.

THE FOUR EVENTS
A task with a deadline generates up to three plans up front:

    lead   — before due_at, scaled by importance: the "don't forget" nudge
    due    — at due_at
    chase  — after due_at: "did you do it?", the one carrying the action
             buttons (Done / Snooze / Reschedule)

The fourth, `escalate`, is deliberately NOT planned here. It only makes sense
once a chase has actually gone unanswered, so the dispatcher creates it after
the fact. Planning it up front would mean cancelling it nearly every time.

ONE LEAD, NOT THREE
An earlier sketch gave important tasks a ladder of leads (a day before, two
hours before, fifteen minutes before). That is precisely the behaviour the
daily budget exists to prevent: three notifications for one task crowds out
three other tasks entirely. Importance buys a longer runway, not more
interruptions.

TASKS WITH NO DEADLINE GET NOTHING
A deliberate boundary. Every event here is defined relative to due_at, and
inventing a time for a task that has none produces reminders the user cannot
predict and did not ask for. Neglected undated tasks already resurface
through attention_decay in scoring.py, which raises them in the universe
without interrupting anyone.
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Ordered most- to least-urgent. Used to break ties when the daily budget
# cannot cover everything that came due at once: being asked whether you did
# the thing beats being warned about a different thing.
KIND_PRIORITY = {"escalate": 3, "due": 2, "chase": 1, "lead": 0}

# Importance is 1-10 (see task_bubbles). Higher importance earns a longer
# runway so there is time to actually act, not a louder alarm.
_LEAD_OFFSETS = (
    (9, timedelta(days=1)),
    (7, timedelta(hours=4)),
    (5, timedelta(hours=2)),
    (3, timedelta(hours=1)),
    (1, timedelta(minutes=30)),
)

# How long after the deadline to ask whether it got done. Low-importance
# tasks are chased the next morning instead of the same evening — nobody
# needs to be asked at 22:40 whether they renewed the library book.
_CHASE_DELAYS = (
    (9, timedelta(minutes=30)),
    (5, timedelta(hours=2)),
)
_CHASE_NEXT_MORNING_BELOW = 5

# proactivity_level (1-5) becomes a hard ceiling on notifications per day.
# Level 3 is the database default and should feel like a well-behaved
# reminders app; level 1 should feel nearly silent.
_DAILY_BUDGET = {1: 2, 2: 4, 3: 6, 4: 10, 5: 20}

# Where a reminder displaced by quiet hours lands, when quiet hours end at
# an hour nobody would call morning. Not used for normal settings.
_DEFAULT_MORNING = time(8, 0)


@dataclass(frozen=True)
class PlannedReminder:
    """One scheduled notification, before it is written to the database."""

    kind: str
    trigger_at: datetime


def daily_budget(proactivity_level: int | None) -> int:
    """Maximum notifications per day for this proactivity level."""
    return _DAILY_BUDGET.get(proactivity_level or 3, _DAILY_BUDGET[3])


def resolve_zone(name: str | None) -> ZoneInfo:
    """Return the user's zone, falling back to UTC.

    A bad or missing zone must not stop reminders — a user whose client sent
    a zone this Python build doesn't know should still be reminded, just in
    UTC, rather than silently receiving nothing forever.
    """
    if not name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _lead_offset(importance: int) -> timedelta:
    for threshold, offset in _LEAD_OFFSETS:
        if importance >= threshold:
            return offset
    return _LEAD_OFFSETS[-1][1]


def _chase_delay(importance: int) -> timedelta | None:
    """Delay after due_at, or None meaning 'the next morning'."""
    for threshold, delay in _CHASE_DELAYS:
        if importance >= threshold:
            return delay
    return None


def in_quiet_hours(moment_local: datetime, start: time, end: time) -> bool:
    """Is this local wall-clock time inside the user's quiet window?

    The window normally wraps midnight (22:00 -> 08:00), so it cannot be a
    simple start <= t <= end comparison — that test is false for every hour
    of a wrapping window and would have made quiet hours a no-op.
    """
    if start == end:
        # Zero-width window: the user has effectively switched quiet hours
        # off. Treating it as "always quiet" would mute the app forever.
        return False
    current = moment_local.timetz().replace(tzinfo=None)
    if start < end:
        return start <= current < end
    return current >= start or current < end


def shift_out_of_quiet_hours(
    moment_utc: datetime, zone: ZoneInfo, start: time, end: time
) -> datetime:
    """Move a trigger forward to the end of quiet hours, if it lands inside.

    Forward, never backward: pulling a reminder earlier would fire it before
    the thing it is about. A reminder that would have arrived at 03:00
    arrives when the user wakes instead of not at all — it is still the
    earliest honest moment to deliver it.
    """
    local = moment_utc.astimezone(zone)
    if not in_quiet_hours(local, start, end):
        return moment_utc

    target = end if end != start else _DEFAULT_MORNING
    candidate = local.replace(
        hour=target.hour, minute=target.minute, second=0, microsecond=0
    )
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def _parse_time(value) -> time | None:
    if isinstance(value, time):
        return value
    if not value:
        return None
    try:
        return time.fromisoformat(str(value))
    except ValueError:
        return None


def _parse_due(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def plan_for_task(
    task: dict,
    preferences: dict,
    *,
    now: datetime,
    cluster_muted: bool = False,
) -> list[PlannedReminder]:
    """Every reminder this task should have scheduled, as of `now`.

    Returns an empty list — never a partial one — whenever the task is not
    eligible at all: no deadline, not active, reminders switched off, or the
    task sitting in a muted cluster. Callers treat the result as the complete
    desired state and cancel any pending plan not in it, so "no reminders"
    has to be expressible.

    Triggers already in the past are dropped rather than fired immediately.
    A task created an hour after its own deadline should not detonate three
    notifications the moment it is saved.
    """
    if not preferences.get("reminders_enabled", True) or cluster_muted:
        return []
    if task.get("status") != "active":
        return []

    due_at = _parse_due(task.get("due_at"))
    if due_at is None:
        return []

    zone = resolve_zone(preferences.get("timezone"))
    quiet_start = _parse_time(preferences.get("quiet_hours_start")) or time(22, 0)
    quiet_end = _parse_time(preferences.get("quiet_hours_end")) or time(8, 0)
    importance = int(task.get("importance") or 5)

    planned: list[PlannedReminder] = []

    if preferences.get("lead_reminders_enabled", True):
        lead_at = due_at - _lead_offset(importance)
        lead_at = shift_out_of_quiet_hours(lead_at, zone, quiet_start, quiet_end)
        # Quiet hours can push a lead past the deadline it was warning
        # about. At that point it is not a lead, it is a confusing echo of
        # the `due` notification — drop it and let `due` do the work.
        if lead_at > now and lead_at < due_at:
            planned.append(PlannedReminder("lead", lead_at))

    due_trigger = shift_out_of_quiet_hours(due_at, zone, quiet_start, quiet_end)
    if due_trigger > now:
        planned.append(PlannedReminder("due", due_trigger))

    if preferences.get("chase_reminders_enabled", True):
        delay = _chase_delay(importance)
        if delay is not None:
            chase_at = due_at + delay
        else:
            # The first morning after the deadline, local time — computed in
            # the user's zone so a deadline at 23:00 in Lisbon is chased at
            # 08:00 in Lisbon and not at whatever 08:00 UTC happens to be.
            #
            # "First morning after", not "tomorrow's morning": a deadline at
            # 02:30 has its next morning the SAME day, a few hours later.
            # Adding a day unconditionally chased those a whole extra day
            # late, some 30 hours after the deadline.
            due_local = due_at.astimezone(zone)
            morning = due_local.replace(
                hour=quiet_end.hour, minute=quiet_end.minute, second=0, microsecond=0
            )
            if morning <= due_local:
                morning += timedelta(days=1)
            chase_at = morning.astimezone(timezone.utc)
        chase_at = shift_out_of_quiet_hours(chase_at, zone, quiet_start, quiet_end)
        if chase_at > now:
            planned.append(PlannedReminder("chase", chase_at))

    return planned


def escalation_for(chase_trigger_at: datetime, preferences: dict) -> PlannedReminder:
    """The single follow-up after an unanswered chase.

    One, then silence. A reminder the user has already ignored twice is not
    information they are missing; it is a task they have decided about
    without telling us, and a third push teaches them to swipe the app's
    notifications away without reading them.
    """
    zone = resolve_zone(preferences.get("timezone"))
    quiet_start = _parse_time(preferences.get("quiet_hours_start")) or time(22, 0)
    quiet_end = _parse_time(preferences.get("quiet_hours_end")) or time(8, 0)
    trigger = shift_out_of_quiet_hours(
        chase_trigger_at + timedelta(days=1), zone, quiet_start, quiet_end
    )
    return PlannedReminder("escalate", trigger)


def rank_for_budget(plans: list[dict]) -> list[dict]:
    """Order due plans so the budget is spent on what matters most.

    Kind outranks pressure: a task you were asked about and didn't answer
    is a stronger claim on the day's last slot than a higher-scoring task
    you haven't been told about yet. Pressure breaks ties within a kind,
    and the trigger time breaks ties within that, so the ordering is total
    and the same input always produces the same output.
    """
    return sorted(
        plans,
        key=lambda p: (
            -KIND_PRIORITY.get(p.get("kind", ""), 0),
            -float(p.get("pressure_score") or 0.0),
            str(p.get("trigger_at") or ""),
        ),
    )
