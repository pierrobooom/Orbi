"""Turn scheduled notification plans into actual pushes.

Two entry points:

    sync_task_plans(...)  — called whenever a task changes, to bring its
                            scheduled reminders back in line with reality
    dispatch_due(...)     — called on a timer, to send whatever is now due

WHY THE BUDGET IS APPLIED HERE AND NOT WHEN PLANNING
A plan is created the moment a task is saved, which may be weeks before it
fires. How busy that day turns out to be is unknowable then. Enforcing the
cap at send time means the user's proactivity setting throttles what actually
reaches them, which is the thing they were choosing, and a quiet week is
never rationed on the strength of a guess made a fortnight earlier.

WHAT HAPPENS TO WHAT DOESN'T FIT
Losers are marked `skipped`, not deleted and not deferred to tomorrow.
Deferring would build a queue that outlives the day it was about, so someone
on the lowest setting would receive a permanently lagging drip of stale
reminders. A skipped reminder is a deliberate silence, recorded so it can be
explained later.
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from app.db import (
    clusters as clusters_db,
    device_tokens as device_tokens_db,
    notifications as notifications_db,
    tasks as tasks_db,
    users as users_db,
)
from app.services.push import send_push
from app.services.reminder_schedule import (
    daily_budget,
    escalation_for,
    in_quiet_hours,
    plan_for_task,
    rank_for_budget,
    resolve_zone,
    shift_out_of_quiet_hours,
)

logger = logging.getLogger(__name__)

# How often the background loop wakes. A minute is far finer than any
# reminder needs and keeps the loop cheap; the cost of a tick with nothing
# due is a single indexed query returning no rows.
DISPATCH_INTERVAL_SECONDS = 60

# Ceiling per tick. Bounds the damage if a bug schedules thousands of plans,
# and bounds the catch-up burst after the server has been down — the backlog
# drains over several ticks instead of one enormous fan-out.
_MAX_PER_TICK = 200

# iOS/Android notification categories, which the client registers to get
# action buttons (Done / Snooze / Reply). Sent now so no backend change is
# needed once the dev build lands and categories start being honoured;
# until then the payload field is simply ignored.
_CATEGORIES = {
    "lead": "orbi.task.lead",
    "due": "orbi.task.due",
    "chase": "orbi.task.chase",
    "escalate": "orbi.task.chase",
}

# How a notification is laid out, and why.
#
# The first version led with the kind ("Coming up", "Due now") and pushed
# the task into the body. That is backwards: on a lock screen the bold
# first line is the only thing reliably read, and "Coming up" is the one
# piece of information the user already has — they know it's a reminder,
# it came from a reminders app. So the TITLE is the task itself.
#
# iOS gives a second bold line, the subtitle, which is exactly the shape
# of a countdown, so that is where "in 1h 30m" goes. Android drops the
# subtitle, so the body repeats nothing essential but must still stand
# alone there.
#
#   Tomar banho            <- title: what
#   Daqui a 1h 30m         <- subtitle: when (iOS only)
#   Adrift                 <- body: context, or the question being asked
#
# Copy is templated rather than generated: it must be identical every
# time, and translating it is a dictionary lookup instead of a prompt.


def _is_pt(language: str | None) -> bool:
    return (language or "").lower().startswith("pt")


def _format_duration(minutes: int, portuguese: bool) -> str:
    """A compact human duration: "45 min", "1h 30m", "2 d 4h", "3 weeks".

    Two units at most. "1 day, 4 hours and 12 minutes" is a train
    timetable, not a nudge, and the extra precision changes no decision.
    """
    if minutes < 60:
        return f"{minutes} min"
    if minutes < 1440:
        hours, rest = divmod(minutes, 60)
        return f"{hours}h {rest}m" if rest else f"{hours}h"
    if minutes < 20160:  # under a fortnight, days read better than weeks
        days, rest = divmod(minutes, 1440)
        hours = rest // 60
        unit = "dia" if portuguese and days == 1 else ("dias" if portuguese else ("day" if days == 1 else "days"))
        return f"{days} {unit} {hours}h" if hours else f"{days} {unit}"
    weeks = minutes // 10080
    if portuguese:
        return f"{weeks} semana" if weeks == 1 else f"{weeks} semanas"
    return f"{weeks} week" if weeks == 1 else f"{weeks} weeks"


def _countdown(due_at: datetime | None, now: datetime, language: str | None) -> str:
    """The subtitle line: how long until the deadline, or how far past it."""
    portuguese = _is_pt(language)
    if due_at is None:
        return "Sem prazo" if portuguese else "No deadline"

    delta = (due_at - now).total_seconds()
    minutes = int(abs(delta) // 60)

    if minutes < 1:
        return "É agora" if portuguese else "Due now"

    duration = _format_duration(minutes, portuguese)
    if delta < 0:
        return f"Atrasada {duration}" if portuguese else f"{duration} overdue"
    return f"Daqui a {duration}" if portuguese else f"Due in {duration}"


# Body line per kind. `lead` and `due` carry context (which cluster this
# belongs to); `chase` and `escalate` carry the question they are asking,
# because that question is the whole point of them.
_BODY = {
    "en": {
        "chase": "Did you get this done?",
        "escalate": "Still open — worth a decision.",
    },
    "pt": {
        "chase": "Já está feita?",
        "escalate": "Continua em aberto — vale a pena decidir.",
    },
}

_NO_CLUSTER = {"en": "Adrift", "pt": "Adrift"}


def _parse_dt(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_time(value, fallback: time) -> time:
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value))
    except (ValueError, TypeError):
        return fallback


_DEFAULT_PREFERENCES = {
    "reminders_enabled": True,
    "lead_reminders_enabled": True,
    "chase_reminders_enabled": True,
    "quiet_hours_start": "22:00:00",
    "quiet_hours_end": "08:00:00",
    "proactivity_level": 3,
    "timezone": "UTC",
    "language": "en-GB",
}


async def preferences_for(user_id: UUID) -> dict:
    """Preferences with defaults filled in.

    A user who has never opened Settings has no preferences row, and that
    must mean "the sensible defaults" rather than "no reminders" — otherwise
    the feature is invisible to everyone who didn't go looking for it.
    """
    stored = await users_db.fetch_preferences(user_id) or {}
    return {**_DEFAULT_PREFERENCES, **{k: v for k, v in stored.items() if v is not None}}


def _same_schedule(existing: list[dict], planned: list) -> bool:
    """Do the stored pending plans already match what we just computed?

    Compared as (kind, instant) pairs so a difference in how Postgres and
    Python spell the same moment — "+00:00" versus "Z", trailing zeros on
    the seconds — doesn't read as a change and trigger a pointless rewrite.
    """
    stored = set()
    for row in existing:
        moment = _parse_dt(row.get("trigger_at"))
        if moment is None:
            return False
        stored.add((row.get("kind"), moment))
    wanted = {(p.kind, p.trigger_at) for p in planned}
    return stored == wanted


async def sync_task_plans(
    task: dict,
    owner_id: UUID,
    *,
    preferences: dict | None = None,
    now: datetime | None = None,
) -> list[dict]:
    """Recompute this task's scheduled reminders from scratch.

    Cancel-then-insert rather than diff-and-patch. The plan set for a task is
    small (at most three rows) and fully determined by the task plus the
    user's settings, so recomputing it is simpler than reasoning about which
    of a due-date change, an importance change, a cluster move or a mute
    should invalidate which row — and it cannot drift.

    Already-sent plans are untouched: only pending rows are cancelled, so the
    record of what the user actually received survives every edit.
    """
    now = now or datetime.now(timezone.utc)
    prefs = preferences or await preferences_for(owner_id)

    cluster_muted = False
    cluster_id = task.get("parent_cluster_id")
    if cluster_id:
        cluster = await clusters_db.fetch_cluster_by_id(UUID(str(cluster_id)), owner_id)
        cluster_muted = bool(cluster and cluster.get("notifications_muted"))

    task_id = UUID(str(task["id"]))
    planned = plan_for_task(task, prefs, now=now, cluster_muted=cluster_muted)

    # Nothing to do when the schedule hasn't actually moved. Without this
    # check every settings toggle cancelled and reinserted an identical set
    # of rows: three tasks had accumulated sixty plans, fifty-one of them
    # cancelled duplicates, purely from flipping switches in Settings.
    existing = await notifications_db.fetch_pending_for_task(task_id)
    if _same_schedule(existing, planned):
        return []

    await notifications_db.cancel_pending_for_task(task_id)
    if not planned:
        return []

    rows = [
        {
            "owner_id": str(owner_id),
            "task_id": str(task["id"]),
            "kind": p.kind,
            "trigger_at": p.trigger_at.isoformat(),
        }
        for p in planned
    ]
    try:
        return await notifications_db.insert_plans(rows)
    except Exception as exc:  # noqa: BLE001
        # Two rapid edits to the same task can interleave their cancel and
        # insert, and the loser hits the partial unique index. That is the
        # index doing its job — the winner already wrote the same schedule,
        # so there is nothing to retry and nothing to report.
        logger.info("Plans not inserted for task %s: %s", task.get("id"), exc)
        return []


async def resync_user_plans(owner_id: UUID) -> tuple[int, int]:
    """Replan every active task this user owns. Returns (tasks, plans).

    Needed whenever a setting changes the schedule globally rather than a
    single task: quiet hours, timezone, the reminder switches. Cheap enough
    to call on any such save — a user has tens of active tasks, not
    thousands, and each is three rows of arithmetic.
    """
    prefs = await preferences_for(owner_id)
    now = datetime.now(timezone.utc)

    all_tasks = await tasks_db.fetch_tasks_for_user(owner_id)
    active = [t for t in all_tasks if t.get("status") == "active"]

    scheduled = 0
    for task in active:
        try:
            rows = await sync_task_plans(task, owner_id, preferences=prefs, now=now)
            scheduled += len(rows)
        except Exception as exc:  # noqa: BLE001 — one task must not fail the rest
            logger.warning("Resync failed for task %s: %s", task.get("id"), exc)
    return len(active), scheduled


async def resync_cluster_plans(owner_id: UUID, cluster_id: UUID) -> int:
    """Replan every active task in one cluster. Returns plans scheduled.

    Called when a cluster is unmuted. The mute cancelled those plans
    outright, so there is nothing to un-cancel — the schedule has to be
    rebuilt from the tasks, which is exactly what sync does per task.
    """
    prefs = await preferences_for(owner_id)
    now = datetime.now(timezone.utc)

    all_tasks = await tasks_db.fetch_tasks_for_user(owner_id)
    in_cluster = [
        t
        for t in all_tasks
        if t.get("status") == "active"
        and str(t.get("parent_cluster_id") or "") == str(cluster_id)
    ]

    scheduled = 0
    for task in in_cluster:
        try:
            rows = await sync_task_plans(task, owner_id, preferences=prefs, now=now)
            scheduled += len(rows)
        except Exception as exc:  # noqa: BLE001 — one task must not fail the rest
            logger.warning("Cluster resync failed for task %s: %s", task.get("id"), exc)
    return scheduled


async def dispatch_due(now: datetime | None = None) -> dict:
    """Send every notification that is due, within each user's daily budget.

    Returns a small summary the caller can log or return from the manual
    endpoint: how many plans were considered, sent, skipped and postponed.
    """
    now = now or datetime.now(timezone.utc)
    due = await notifications_db.fetch_due_plans(now, limit=_MAX_PER_TICK)
    if not due:
        return {"considered": 0, "sent": 0, "skipped": 0, "postponed": 0}

    by_owner: dict[str, list[dict]] = defaultdict(list)
    for plan in due:
        by_owner[str(plan["owner_id"])].append(plan)

    sent_total = 0
    skipped_total = 0
    postponed_total = 0

    for owner_id_str, plans in by_owner.items():
        owner_id = UUID(owner_id_str)
        try:
            result = await _dispatch_for_owner(owner_id, plans, now)
        except Exception as exc:  # noqa: BLE001 — one user must not stop the rest
            logger.error("Reminder dispatch failed for %s: %s", owner_id_str, exc)
            continue
        sent_total += result["sent"]
        skipped_total += result["skipped"]
        postponed_total += result["postponed"]

    return {
        "considered": len(due),
        "sent": sent_total,
        "skipped": skipped_total,
        "postponed": postponed_total,
    }


async def _cluster_names_for(owner_id: UUID) -> dict[str, str]:
    """Cluster id -> name, for the body line. Never fails a dispatch.

    A notification that says which part of your life a task belongs to is
    more useful than one that doesn't, but not so much more useful that a
    failed lookup should stop it being sent.
    """
    try:
        rows = await clusters_db.fetch_clusters_for_user(owner_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cluster names unavailable for notification body: %s", exc)
        return {}
    return {str(c["id"]): str(c.get("name") or "") for c in rows}


async def _dispatch_for_owner(
    owner_id: UUID, plans: list[dict], now: datetime
) -> dict:
    prefs = await preferences_for(owner_id)
    zone = resolve_zone(prefs.get("timezone"))
    quiet_start = _parse_time(prefs.get("quiet_hours_start"), time(22, 0))
    quiet_end = _parse_time(prefs.get("quiet_hours_end"), time(8, 0))

    # A plan is shifted out of quiet hours when it is created, but downtime
    # or a changed quiet window can still leave one sitting due at 03:00.
    # Push it to morning instead of sending it, so recovering from an outage
    # never means waking people up.
    postponed: list[str] = []
    ready: list[dict] = []
    if in_quiet_hours(now.astimezone(zone), quiet_start, quiet_end):
        new_trigger = shift_out_of_quiet_hours(now, zone, quiet_start, quiet_end)
        for plan in plans:
            postponed.append(plan["id"])
        await notifications_db.postpone_plans(postponed, new_trigger)
        return {"sent": 0, "skipped": 0, "postponed": len(postponed)}

    # Drop plans whose task has since been completed or archived without a
    # sync — belt and braces against a write path that forgot to call
    # sync_task_plans. Cheaper to check than to apologise for.
    stale: list[str] = []
    for plan in plans:
        task = plan.get("task_bubbles")
        if not task or task.get("status") != "active":
            stale.append(plan["id"])
        else:
            ready.append(plan)
    if stale:
        await notifications_db.mark_state(stale, "cancelled")
    if not ready:
        return {"sent": 0, "skipped": 0, "postponed": 0}

    # The budget resets at local midnight, not UTC midnight — otherwise a
    # user in Lisbon gets their allowance back mid-evening in summer.
    local_midnight = now.astimezone(zone).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    already_sent = await notifications_db.count_sent_since(
        owner_id, local_midnight.astimezone(timezone.utc)
    )
    remaining = max(daily_budget(prefs.get("proactivity_level")) - already_sent, 0)

    ranked = rank_for_budget(
        [
            {**p, "pressure_score": (p.get("task_bubbles") or {}).get("pressure_score")}
            for p in ready
        ]
    )
    winners = ranked[:remaining]
    losers = ranked[remaining:]

    if losers:
        await notifications_db.mark_state([p["id"] for p in losers], "skipped")

    if not winners:
        return {"sent": 0, "skipped": len(losers), "postponed": 0}

    tokens = await device_tokens_db.list_tokens_for_user(owner_id)
    if not tokens:
        # No device to reach. Marking these sent would burn the budget on
        # notifications nobody received; skipped records the attempt without
        # the lie.
        await notifications_db.mark_state([p["id"] for p in winners], "skipped")
        return {"sent": 0, "skipped": len(losers) + len(winners), "postponed": 0}

    language = prefs.get("language")
    lang_key = "pt" if _is_pt(language) else "en"
    cluster_names = await _cluster_names_for(owner_id)

    sent_ids: list[str] = []
    for plan in winners:
        task = plan.get("task_bubbles") or {}
        kind = plan["kind"]

        cluster_id = task.get("parent_cluster_id")
        cluster = cluster_names.get(str(cluster_id)) if cluster_id else None
        body = _BODY[lang_key].get(kind) or cluster or _NO_CLUSTER[lang_key]

        await send_push(
            tokens,
            title=task.get("title") or "",
            subtitle=_countdown(_parse_dt(task.get("due_at")), now, language),
            body=body,
            category_id=_CATEGORIES.get(kind, _CATEGORIES["due"]),
            data={
                "kind": kind,
                "planId": plan["id"],
                "taskId": str(plan["task_id"]),
            },
        )
        sent_ids.append(plan["id"])

    await notifications_db.mark_state(sent_ids, "sent")

    # A chase that goes unanswered earns exactly one follow-up. Scheduled
    # only now, once we know the chase actually went out — planning it in
    # advance would mean cancelling it almost every time.
    if prefs.get("chase_reminders_enabled", True):
        await _schedule_escalations(owner_id, winners, prefs, now)

    return {"sent": len(sent_ids), "skipped": len(losers), "postponed": 0}


async def _schedule_escalations(
    owner_id: UUID, sent_plans: list[dict], prefs: dict, now: datetime
) -> None:
    rows = []
    for plan in sent_plans:
        if plan["kind"] != "chase":
            continue
        escalation = escalation_for(now, prefs)
        rows.append(
            {
                "owner_id": str(owner_id),
                "task_id": str(plan["task_id"]),
                "kind": escalation.kind,
                "trigger_at": escalation.trigger_at.isoformat(),
            }
        )
    if rows:
        try:
            await notifications_db.insert_plans(rows)
        except Exception as exc:  # noqa: BLE001
            # A duplicate escalation loses to the unique index, which is the
            # index doing its job. Never let it fail the tick.
            logger.info("Escalation not scheduled: %s", exc)


async def run_forever() -> None:
    """Background loop. Started from main.py's lifespan, cancelled on shutdown.

    A plain asyncio task rather than APScheduler or Celery: the work is one
    indexed query a minute, the schedule itself lives in Postgres so nothing
    is lost on restart, and adding a scheduler dependency would buy only
    features this does not use. If the API ever runs more than one instance,
    replace this with a single external cron hitting POST /notifications/
    dispatch — the endpoint exists for exactly that, and the handler is
    already safe to call concurrently.
    """
    logger.info("Reminder dispatcher started (every %ss)", DISPATCH_INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.sleep(DISPATCH_INTERVAL_SECONDS)
            result = await dispatch_due()
            if result["sent"] or result["skipped"] or result["postponed"]:
                logger.info("Reminder tick: %s", result)
        except asyncio.CancelledError:
            logger.info("Reminder dispatcher stopping")
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must outlive any tick
            logger.error("Reminder tick failed: %s", exc)
