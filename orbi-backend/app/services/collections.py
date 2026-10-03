"""Collections: resources, their routines, and each period's bubble.

LAYERS
    cluster (is_collection) → resource → optional unit → routine (≤5)
      → occurrence (one per period) → payments, and one task bubble

WHAT THIS MODULE OWNS
    - creating the periods that should exist, and their bubbles
    - recording payments, and closing a period when they reach its amount
    - keeping bubbles in step when a routine or resource is edited
    - the read models the screens draw

WHAT IT DOES NOT OWN
    - when periods fall: services/recurrence.py (pure, tested)
    - reminders: the ordinary task pipeline, through the period's bubble
    - "is this period finished": the bubble's status. A trigger mirrors it
      onto the occurrence (migration 0026), so completing the bubble by any
      route — hold, notification, voice — closes the period.

Money is Decimal throughout, never float: "€200 of €600" must add up to the
cent however many part-payments there are.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID, uuid4

from app.db import collections as db
from app.db import finance as finance_db
from app.db import tasks as tasks_db
from app.models.collection import PaymentCreate
from app.models.task import TaskBubble, persistable
from app.services import recurrence
from app.services.reminder_dispatcher import preferences_for, sync_task_plans
from app.services.scoring import calculate_pressure_score

logger = logging.getLogger(__name__)

# Top-level resources per tier ("Casa 1", "Millie"). Units inside them are
# bounded separately, and routines by the table (five per resource).
RESOURCE_CAPS: dict[str, int | None] = {"free": 3, "pro": 30, "premium": None}
MAX_UNITS_PER_RESOURCE = 20

# A money period presses harder than a chore: an unpaid rent is a debt.
_IMPORTANCE = {"amount": 7, "check": 5}

# How often the background pass runs. Periods are created days ahead, so
# minutes of lag change nothing; this only bounds the work.
MATERIALIZE_EVERY = timedelta(minutes=15)


class CollectionError(Exception):
    """A request the rules refuse. Carries a message safe to show the user."""

    def __init__(self, message: str, code: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _dec(value) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def _money(value) -> str:
    """Money as the API spells it: always two decimals ("400.00").

    The database hands numeric columns back as floats (400.0), so without
    this the same amount read "400.0" in one response and "400.00" in
    another — harmless to arithmetic, but not to anything comparing them.
    """
    return str(_dec(value).quantize(Decimal("0.01")))


def _pct(paid: Decimal, amount: Decimal | None) -> int:
    if not amount or amount <= 0:
        return 0
    return int(min(Decimal(100), (paid / amount * 100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _parse_date(value) -> date | None:
    if value is None or isinstance(value, date) and not isinstance(value, datetime):
        return value
    return date.fromisoformat(str(value)[:10])


def _parse_time(value) -> time:
    if isinstance(value, time):
        return value
    return time.fromisoformat(str(value or "09:00:00"))


def _parse_dt(value) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _schedule(routine: dict) -> recurrence.Schedule:
    return recurrence.Schedule(
        anchor_on=_parse_date(routine["anchor_on"]),
        frequency=routine["frequency"],
        interval_count=int(routine.get("interval_count") or 1),
        on_miss=routine.get("on_miss") or "stay_overdue",
        remind_before_days=routine.get("remind_before_days"),
    )


def _local_date(moment, tz_name: str | None) -> date | None:
    parsed = _parse_dt(moment)
    return recurrence.local_today(parsed, tz_name) if parsed else None


def _task_texts(routine: dict, resource: dict) -> tuple[str, str]:
    """(title, label) for a period's bubble.

    A unit's period names the unit ("Renda Quarto 3"), because a house has
    several rooms and "Renda" alone would be three identical bubbles. A
    resource's own period is just the routine ("Vacina"); who it is about is
    on the subtitle line the client draws.
    """
    if resource.get("parent_id"):
        text = f"{routine['title']} {resource['name']}"
    else:
        text = f"{routine['title']} · {resource['name']}"
    title = text[:80]
    label = (f"{routine['title']} {resource['name']}" if resource.get("parent_id") else routine["title"])[:28]
    return title, label


def _reminder_fields(routine: dict) -> dict:
    before = routine.get("remind_before_days")
    after = routine.get("remind_after_days")
    return {
        "reminder_lead_minutes": int(before) * 1440 if before else 0,
        "reminder_on_due": bool(routine.get("remind_on_day", True)),
        "reminder_chase_minutes": int(after) * 1440 if after else 0,
    }


# ---------------------------------------------------------------------------
# Periods and their bubbles
# ---------------------------------------------------------------------------

async def _create_task(occurrence: dict, routine: dict, resource: dict, cluster_id: str,
                       owner_id: UUID, prefs: dict) -> dict | None:
    """The bubble for one period. None if another pass already made it."""
    now = datetime.now(timezone.utc)
    title, label = _task_texts(routine, resource)
    task = TaskBubble(
        id=uuid4(),
        owner_id=owner_id,
        title=title,
        label=label,
        status="active",
        due_at=_parse_dt(occurrence["due_at"]),
        importance=_IMPORTANCE.get(routine["kind"], 5),
        urgency_score=0.0,
        pressure_score=0.0,
        parent_cluster_id=UUID(str(cluster_id)),
        source_type="routine",
        confidence=1.0,
        routine_occurrence_id=UUID(str(occurrence["id"])),
        created_at=now,
        updated_at=now,
        **_reminder_fields(routine),
    )
    payload = persistable(task)
    payload["pressure_score"] = calculate_pressure_score(task)
    try:
        row = await tasks_db.insert_task(payload)
    except Exception as exc:  # noqa: BLE001
        # The unique index on routine_occurrence_id: a concurrent pass made
        # this bubble first. Exactly the outcome wanted.
        logger.info("Bubble for occurrence %s not created: %s", occurrence["id"], exc)
        return None
    await sync_task_plans(row, owner_id, preferences=prefs)
    return row


async def _close_task(task: dict, owner_id: UUID, status: str) -> None:
    """Complete or archive a period's bubble and clear its reminders."""
    now = datetime.now(timezone.utc).isoformat()
    fields = {"status": status, "updated_at": now}
    if status == "completed":
        fields["completed_at"] = now
    row = await tasks_db.update_task(UUID(str(task["id"])), owner_id, fields)
    await sync_task_plans(row or {**task, **fields}, owner_id)


async def materialize_routine(routine: dict, *, now: datetime | None = None,
                              prefs: dict | None = None) -> list[dict]:
    """Create every period of this routine that should exist now. Idempotent.

    Safe to run as often as wanted, from any number of places at once: the
    period key and the one-bubble-per-period index make a duplicate
    impossible, not merely unlikely. Also repairs a period left without a
    bubble by a crash between the two inserts.
    """
    if routine.get("archived_at"):
        return []
    now = now or datetime.now(timezone.utc)
    owner_id = UUID(str(routine["owner_id"]))
    prefs = prefs or await preferences_for(owner_id)
    tz_name = prefs.get("timezone")
    today = recurrence.local_today(now, tz_name)

    resource = await db.fetch_resource(UUID(str(routine["resource_id"])), owner_id)
    if resource is None or resource.get("archived_at"):
        return []

    schedule = _schedule(routine)
    open_rows = await db.fetch_open_occurrences(UUID(str(routine["id"])))
    last_closed = await db.fetch_latest_closed(UUID(str(routine["id"])))
    wanted = recurrence.periods_to_create(
        schedule,
        today=today,
        materialized_through=_parse_date(routine.get("materialized_through")),
        open_periods=[recurrence.OpenPeriod(_parse_date(o["period_on"])) for o in open_rows],
        last_done_on=_local_date(last_closed.get("completed_at"), tz_name) if last_closed else None,
        starts_on=_local_date(routine["created_at"], tz_name) or today,
    )

    created: list[dict] = []
    due_time = _parse_time(routine.get("due_time"))
    for period in wanted:
        row = await db.insert_occurrence({
            "owner_id": str(owner_id),
            "routine_id": str(routine["id"]),
            "period_on": period.isoformat(),
            "due_at": recurrence.due_at(period, due_time, tz_name).isoformat(),
            "amount": str(routine["amount"]) if routine.get("amount") is not None else None,
        })
        if row is not None:
            created.append(row)

    if wanted:
        await db.update_routine(UUID(str(routine["id"])), owner_id,
                                {"materialized_through": max(wanted).isoformat()})

    # skip_ahead: a newer period replaces older unfinished ones. Re-read
    # after creating, so nothing made in this pass is missed.
    if wanted and schedule.on_miss == "skip_ahead":
        newest = max(wanted)
        current_open = await db.fetch_open_occurrences(UUID(str(routine["id"])))
        stale = [o for o in current_open if _parse_date(o["period_on"]) < newest]
        await _skip(stale, owner_id)

    await _ensure_bubbles(routine, resource, owner_id, prefs)
    return created


async def _skip(occurrences: list[dict], owner_id: UUID) -> None:
    """Close periods as skipped — through their bubbles when they have one."""
    if not occurrences:
        return
    tasks = {t["routine_occurrence_id"]: t for t in await db.fetch_tasks_for_occurrences(
        [str(o["id"]) for o in occurrences])}
    for occ in occurrences:
        task = tasks.get(str(occ["id"]))
        if task and task.get("status") == "active":
            await _close_task(task, owner_id, "archived")  # trigger: skipped
        else:
            await db.update_occurrence(UUID(str(occ["id"])), {
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "closed_reason": "skipped",
            })


async def _ensure_bubbles(routine: dict, resource: dict, owner_id: UUID, prefs: dict) -> None:
    """Give every open period its bubble. Normally a no-op."""
    open_rows = await db.fetch_open_occurrences(UUID(str(routine["id"])))
    if not open_rows:
        return
    have = {t["routine_occurrence_id"] for t in await db.fetch_tasks_for_occurrences(
        [str(o["id"]) for o in open_rows])}
    for occ in open_rows:
        if str(occ["id"]) not in have:
            await _create_task(occ, routine, resource, resource["cluster_id"], owner_id, prefs)


async def materialize_all(now: datetime | None = None) -> int:
    """The background pass: every live routine of every user. Returns periods made."""
    now = now or datetime.now(timezone.utc)
    routines = await db.fetch_live_routines()
    prefs_by_owner: dict[str, dict] = {}
    made = 0
    for routine in routines:
        owner = str(routine["owner_id"])
        try:
            if owner not in prefs_by_owner:
                prefs_by_owner[owner] = await preferences_for(UUID(owner))
            made += len(await materialize_routine(routine, now=now, prefs=prefs_by_owner[owner]))
        except Exception as exc:  # noqa: BLE001 — one routine must not stop the rest
            logger.error("Materialize failed for routine %s: %s", routine.get("id"), exc)
    return made


_last_pass: datetime | None = None


async def materialize_if_due(now: datetime) -> None:
    """Run materialize_all at most once per MATERIALIZE_EVERY. Never raises."""
    global _last_pass
    if _last_pass is not None and now - _last_pass < MATERIALIZE_EVERY:
        return
    _last_pass = now
    try:
        made = await materialize_all(now)
        if made:
            logger.info("Created %s routine period(s)", made)
    except Exception as exc:  # noqa: BLE001
        logger.error("Routine materialize pass failed: %s", exc)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------

async def _owned_collection(cluster_id: UUID, owner_id: UUID) -> dict:
    cluster = await db.fetch_cluster(cluster_id, owner_id)
    if cluster is None:
        raise CollectionError("Collection not found.", "COLLECTION_NOT_FOUND", 404)
    return cluster


async def set_collection(cluster_id: UUID, owner_id: UUID, is_collection: bool,
                         noun: str | None) -> dict:
    await _owned_collection(cluster_id, owner_id)
    row = await db.set_cluster_collection(cluster_id, owner_id, is_collection,
                                          noun.strip() if noun else None)
    return row or {}


async def create_resource(owner_id: UUID, tier: str, body) -> dict:
    """Add a resource to a collection, or a unit to a resource."""
    cluster = await _owned_collection(body.cluster_id, owner_id)
    if not cluster.get("is_collection"):
        # Adding the first resource is what makes a cluster a collection.
        await db.set_cluster_collection(body.cluster_id, owner_id, True, cluster.get("collection_noun"))

    if body.parent_id is not None:
        parent = await db.fetch_resource(body.parent_id, owner_id)
        if parent is None or parent.get("archived_at") or str(parent["cluster_id"]) != str(body.cluster_id):
            raise CollectionError("Resource not found.", "RESOURCE_NOT_FOUND", 404)
        if parent.get("parent_id"):
            raise CollectionError("A unit cannot contain units.", "UNIT_NESTING")
        if len(await db.fetch_units(body.parent_id, owner_id)) >= MAX_UNITS_PER_RESOURCE:
            raise CollectionError(
                f"A resource can have at most {MAX_UNITS_PER_RESOURCE} units.", "UNIT_CAP_REACHED", 403)
    else:
        cap = RESOURCE_CAPS.get(tier, RESOURCE_CAPS["free"])
        if cap is not None and await db.count_top_level_resources(owner_id) >= cap:
            raise CollectionError(
                f"Your plan allows {cap} resources. Archive one, or upgrade for more.",
                "RESOURCE_CAP_REACHED", 403)

    return await db.insert_resource({
        "owner_id": str(owner_id),
        "cluster_id": str(body.cluster_id),
        "parent_id": str(body.parent_id) if body.parent_id else None,
        "name": body.name.strip(),
        "subtitle": (body.subtitle or "").strip() or None,
        "person_name": (body.person_name or "").strip() or None,
        "since_on": body.since_on.isoformat() if body.since_on else None,
    })


async def _owned_resource(resource_id: UUID, owner_id: UUID) -> dict:
    resource = await db.fetch_resource(resource_id, owner_id)
    if resource is None or resource.get("archived_at"):
        raise CollectionError("Resource not found.", "RESOURCE_NOT_FOUND", 404)
    return resource


async def update_resource(resource_id: UUID, owner_id: UUID, body) -> dict:
    resource = await _owned_resource(resource_id, owner_id)
    changes = body.model_dump(exclude_unset=True, mode="json")
    for key in ("name", "subtitle", "person_name"):
        if key in changes and isinstance(changes[key], str):
            changes[key] = changes[key].strip() or (None if key != "name" else resource["name"])
    row = await db.update_resource(resource_id, owner_id, changes) or resource
    if "name" in changes:
        await _retitle_open_bubbles_for_resource(row, owner_id)
    return row


async def archive_resource(resource_id: UUID, owner_id: UUID) -> None:
    """Archive a resource (or unit) with its units and routines.

    Archived, never deleted: payment history is a financial record. Open
    periods are closed as skipped so no bubble or reminder outlives it.
    """
    resource = await _owned_resource(resource_id, owner_id)
    targets = [resource]
    if not resource.get("parent_id"):
        targets += await db.fetch_units(resource_id, owner_id)
    routines = await db.fetch_routines_for_resources([str(r["id"]) for r in targets], owner_id)
    for routine in routines:
        await archive_routine(UUID(str(routine["id"])), owner_id)
    now = datetime.now(timezone.utc).isoformat()
    for target in targets:
        await db.update_resource(UUID(str(target["id"])), owner_id, {"archived_at": now})


# ---------------------------------------------------------------------------
# Routines
# ---------------------------------------------------------------------------

async def create_routine(owner_id: UUID, body) -> dict:
    resource = await _owned_resource(body.resource_id, owner_id)
    live = await db.fetch_routines_for_resources([str(resource["id"])], owner_id)
    if len(live) >= 5:
        raise CollectionError("Each one can have up to 5 routines.", "ROUTINE_CAP_REACHED", 403)
    data = body.model_dump(mode="json")
    routine = await db.insert_routine({
        **data,
        "owner_id": str(owner_id),
        "amount": str(body.amount) if body.amount is not None else None,
        "position": len(live),
    })
    await materialize_routine(routine)
    return routine


async def _owned_routine(routine_id: UUID, owner_id: UUID) -> dict:
    routine = await db.fetch_routine(routine_id, owner_id)
    if routine is None or routine.get("archived_at"):
        raise CollectionError("Routine not found.", "ROUTINE_NOT_FOUND", 404)
    return routine


_SCHEDULE_FIELDS = ("frequency", "interval_count", "anchor_on", "due_time", "on_miss")


async def update_routine(routine_id: UUID, owner_id: UUID, body) -> dict:
    """Edit a routine. Changes apply from now on; history is never rewritten.

    A new schedule removes the not-yet-due periods of the old one (unless
    something has been paid towards them) and continues from today on the
    new dates. A new amount applies to periods nothing has been paid on.
    """
    routine = await _owned_routine(routine_id, owner_id)
    changes = body.model_dump(exclude_unset=True, mode="json")
    if "amount" in changes and changes["amount"] is not None:
        if routine["kind"] != "amount":
            changes.pop("amount")
        else:
            changes["amount"] = str(body.amount)
    if not changes:
        return routine

    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
    schedule_changed = any(
        k in changes and str(changes[k]) != str(routine.get(k)) for k in _SCHEDULE_FIELDS
    )

    open_rows = await db.fetch_open_occurrences(routine_id)
    paid_on = {p["occurrence_id"] for p in await db.fetch_payments([str(o["id"]) for o in open_rows])}

    if schedule_changed:
        future_unpaid = [
            o for o in open_rows
            if _parse_date(o["period_on"]) >= today and str(o["id"]) not in paid_on
        ]
        tasks = {t["routine_occurrence_id"]: t for t in await db.fetch_tasks_for_occurrences(
            [str(o["id"]) for o in future_unpaid])}
        for occ in future_unpaid:
            task = tasks.get(str(occ["id"]))
            if task and task.get("status") == "active":
                await _close_task(task, owner_id, "archived")
            await db.delete_occurrence(UUID(str(occ["id"])))
        remaining = await db.fetch_occurrences_for_routines([str(routine_id)])
        latest = max((_parse_date(o["period_on"]) for o in remaining), default=None)
        on_miss = changes.get("on_miss", routine.get("on_miss"))
        if on_miss == "from_done":
            # The anchor is the next date the user chose; start from it.
            changes["materialized_through"] = None
        else:
            # Continue from today on the new dates — never back-fill the gap
            # between the last old period and now as arrears.
            floor = today - timedelta(days=1)
            changes["materialized_through"] = max(latest, floor).isoformat() if latest else floor.isoformat()

    if "amount" in changes:
        for occ in open_rows:
            if str(occ["id"]) not in paid_on:
                await db.update_occurrence(UUID(str(occ["id"])), {"amount": changes["amount"]})

    row = await db.update_routine(routine_id, owner_id, changes) or routine

    if "title" in changes or any(k in changes for k in ("remind_before_days", "remind_on_day", "remind_after_days")):
        resource = await db.fetch_resource(UUID(str(row["resource_id"])), owner_id)
        if resource:
            await _refresh_open_bubbles(row, resource, owner_id)

    await materialize_routine(row, prefs=prefs)
    return row


async def archive_routine(routine_id: UUID, owner_id: UUID) -> None:
    routine = await _owned_routine(routine_id, owner_id)
    await _skip(await db.fetch_open_occurrences(UUID(str(routine["id"]))), owner_id)
    await db.update_routine(routine_id, owner_id, {"archived_at": datetime.now(timezone.utc).isoformat()})


async def _refresh_open_bubbles(routine: dict, resource: dict, owner_id: UUID) -> None:
    """Rename open bubbles and re-apply reminder choices after an edit."""
    open_rows = await db.fetch_open_occurrences(UUID(str(routine["id"])))
    tasks = await db.fetch_tasks_for_occurrences([str(o["id"]) for o in open_rows])
    title, label = _task_texts(routine, resource)
    for task in tasks:
        if task.get("status") != "active":
            continue
        row = await tasks_db.update_task(UUID(str(task["id"])), owner_id, {
            "title": title, "label": label, **_reminder_fields(routine),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        if row:
            await sync_task_plans(row, owner_id)


async def _retitle_open_bubbles_for_resource(resource: dict, owner_id: UUID) -> None:
    routines = await db.fetch_routines_for_resources([str(resource["id"])], owner_id)
    for routine in routines:
        await _refresh_open_bubbles(routine, resource, owner_id)


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------

async def _occurrence_bundle(occurrence_id: UUID, owner_id: UUID) -> tuple[dict, dict, dict]:
    occ = await db.fetch_occurrence(occurrence_id, owner_id)
    if occ is None:
        raise CollectionError("Period not found.", "OCCURRENCE_NOT_FOUND", 404)
    routine = await db.fetch_routine(UUID(str(occ["routine_id"])), owner_id)
    if routine is None:
        raise CollectionError("Routine not found.", "ROUTINE_NOT_FOUND", 404)
    resource = await db.fetch_resource(UUID(str(routine["resource_id"])), owner_id)
    return occ, routine, resource or {}


async def _task_for(occurrence_id: str) -> dict | None:
    rows = await db.fetch_tasks_for_occurrences([occurrence_id])
    return rows[0] if rows else None


async def _paid_total(occurrence_id: str) -> Decimal:
    return sum((_dec(p["amount"]) for p in await db.fetch_payments([occurrence_id])), Decimal("0"))


async def record_payment(occurrence_id: UUID, owner_id: UUID, body) -> dict:
    """Record money towards a period. Reaching its amount closes it.

    Progress is always the SUM of payment rows, never a stored counter, so it
    cannot drift, and undoing a payment is deleting its row.
    """
    occ, routine, resource = await _occurrence_bundle(occurrence_id, owner_id)
    if routine["kind"] != "amount":
        raise CollectionError("This routine is not paid in amounts.", "NOT_AN_AMOUNT")

    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
    task = await _task_for(str(occ["id"]))
    payment = await db.insert_payment({
        "owner_id": str(owner_id),
        "occurrence_id": str(occ["id"]),
        "amount": str(body.amount),
        "paid_on": (body.paid_on or today).isoformat(),
        "method": body.method,
    })

    if routine.get("log_to_finance"):
        entry_id = await _log_to_finance(payment, routine, resource, task, owner_id)
        if entry_id:
            await db.update_payment(UUID(str(payment["id"])), {"finance_entry_id": entry_id})
            payment["finance_entry_id"] = entry_id

    await _close_if_paid(occ, owner_id, task)
    # A from_done routine's next period depends on this one closing.
    await materialize_routine(routine, prefs=prefs)
    return payment


async def _close_if_paid(occ: dict, owner_id: UUID, task: dict | None) -> None:
    amount = _dec(occ.get("amount"))
    if occ.get("completed_at") or amount <= 0:
        return
    if await _paid_total(str(occ["id"])) >= amount:
        # Mark the occurrence 'paid' BEFORE completing the bubble: the trigger
        # only fills closed_reason when it is empty, so this reason survives.
        await db.update_occurrence(UUID(str(occ["id"])), {
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "closed_reason": "paid",
        })
        if task and task.get("status") == "active":
            await _close_task(task, owner_id, "completed")


async def on_task_completed(task: dict, owner_id: UUID) -> None:
    """A period's bubble was completed the ordinary way — record what it means.

    For a money period, finishing it means it was paid, so whatever is left
    is recorded as a payment dated today and the period closes as 'paid'.
    Without this, completing "Condomínio" from its bubble closed it as
    'done' with no payment at all: nothing in its history, and nothing to
    delete if the tick was a mistake. Now the history always shows how a
    money period was settled, and deleting that payment reopens it.

    A tick-off period needs nothing: the trigger has already closed it.
    Never raises — the task is completed either way.
    """
    occurrence_id = task.get("routine_occurrence_id")
    if not occurrence_id:
        return
    try:
        occ, routine, resource = await _occurrence_bundle(UUID(str(occurrence_id)), owner_id)
        if routine["kind"] == "amount" and occ.get("amount") is not None:
            remaining = _dec(occ["amount"]) - await _paid_total(str(occ["id"]))
            if remaining > 0:
                prefs = await preferences_for(owner_id)
                today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
                payment = await db.insert_payment({
                    "owner_id": str(owner_id),
                    "occurrence_id": str(occ["id"]),
                    "amount": str(remaining),
                    "paid_on": today.isoformat(),
                    "method": None,
                    # Marked, so reopening the bubble can take back exactly
                    # this and leave anything the user typed in (0027).
                    "auto_settled": True,
                })
                if routine.get("log_to_finance"):
                    entry_id = await _log_to_finance(payment, routine, resource, task, owner_id)
                    if entry_id:
                        await db.update_payment(UUID(str(payment["id"])), {"finance_entry_id": entry_id})
            # The trigger closed it as 'done'; paid in full is what happened.
            await db.update_occurrence(UUID(str(occ["id"])), {
                "completed_at": occ.get("completed_at") or datetime.now(timezone.utc).isoformat(),
                "closed_reason": "paid",
            })
        # A from_done routine's next period starts from this completion.
        await materialize_routine(routine)
    except Exception as exc:  # noqa: BLE001
        logger.error("Period follow-up failed for task %s: %s", task.get("id"), exc)


async def on_task_reopened(task: dict, owner_id: UUID) -> None:
    """A completed period's bubble was reopened — undo what completing did.

    Completing a money period records the rest as a payment (auto_settled).
    Reopening takes that payment back, and its Money entry, so the period is
    open again at what the user actually recorded — not open while reading
    100% paid. Payments typed in by hand are never touched. Never raises.
    """
    occurrence_id = task.get("routine_occurrence_id")
    if not occurrence_id:
        return
    try:
        for payment in await db.fetch_payments([str(occurrence_id)]):
            if not payment.get("auto_settled"):
                continue
            if payment.get("finance_entry_id"):
                try:
                    await finance_db.delete_entry(UUID(str(payment["finance_entry_id"])), owner_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Linked finance entry not removed: %s", exc)
            await db.delete_payment(UUID(str(payment["id"])), owner_id)
    except Exception as exc:  # noqa: BLE001
        logger.error("Reopen follow-up failed for task %s: %s", task.get("id"), exc)


async def settle(occurrence_id: UUID, owner_id: UUID, method: str | None = None) -> dict:
    """"Recebido" / "Pago ✓" / "Feito": finish a period in one step.

    An amount routine gets a payment for whatever is left; a check routine is
    ticked done. Settling an already-finished period changes nothing.
    """
    occ, routine, _resource = await _occurrence_bundle(occurrence_id, owner_id)
    if occ.get("completed_at"):
        return occ
    task = await _task_for(str(occ["id"]))
    if routine["kind"] == "amount":
        remaining = _dec(occ.get("amount")) - await _paid_total(str(occ["id"]))
        if remaining > 0:
            await record_payment(occurrence_id, owner_id, PaymentCreate(amount=remaining, method=method))
        else:
            await _close_if_paid(occ, owner_id, task)
    elif task and task.get("status") == "active":
        await _close_task(task, owner_id, "completed")
    else:
        await db.update_occurrence(UUID(str(occ["id"])), {
            "completed_at": datetime.now(timezone.utc).isoformat(), "closed_reason": "done"})
    await materialize_routine(routine)
    return await db.fetch_occurrence(occurrence_id, owner_id) or occ


async def delete_payment(payment_id: UUID, owner_id: UUID) -> None:
    """Undo a payment. A period it had closed opens again."""
    payment = await db.fetch_payment(payment_id, owner_id)
    if payment is None:
        raise CollectionError("Payment not found.", "PAYMENT_NOT_FOUND", 404)
    if payment.get("finance_entry_id"):
        try:
            await finance_db.delete_entry(UUID(str(payment["finance_entry_id"])), owner_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Linked finance entry not removed: %s", exc)
    await db.delete_payment(payment_id, owner_id)

    occ = await db.fetch_occurrence(UUID(str(payment["occurrence_id"])), owner_id)
    if occ and occ.get("closed_reason") == "paid" and \
            await _paid_total(str(occ["id"])) < _dec(occ.get("amount")):
        await db.update_occurrence(UUID(str(occ["id"])), {"completed_at": None, "closed_reason": None})
        task = await _task_for(str(occ["id"]))
        if task and task.get("status") == "completed":
            row = await tasks_db.update_task(UUID(str(task["id"])), owner_id, {
                "status": "active", "completed_at": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            await sync_task_plans(row or task, owner_id)


async def _log_to_finance(payment: dict, routine: dict, resource: dict, task: dict | None,
                          owner_id: UUID) -> str | None:
    """Write a payment into Money. Never fails the payment itself."""
    who = resource.get("person_name") or resource.get("name") or ""
    try:
        row = await finance_db.insert_entry({
            "id": str(uuid4()),
            "user_id": str(owner_id),
            "amount": float(_dec(payment["amount"])),
            "currency": routine.get("currency") or "EUR",
            "merchant": f"{routine['title']} · {who}".strip(" ·")[:80],
            "category": routine.get("finance_category") or ("Rendas" if routine.get("direction") == "income" else "Casa"),
            "entry_type": routine.get("direction") or "income",
            "entry_date": str(payment["paid_on"]),
            "source_type": "routine",
            "linked_bubble_id": str(task["id"]) if task else None,
            # Idempotency: the same payment can never be logged twice.
            "external_id": f"routine-payment:{payment['id']}",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        return str(row["id"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Payment %s not logged to finance: %s", payment.get("id"), exc)
        return None


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------

def ref_month(period_on: date, covers: str | None) -> date:
    """The month a period is FOR, as the first of that month.

    'previous_month' is rent paid in arrears: due 5 October, for September.
    """
    first = period_on.replace(day=1)
    if covers == "previous_month":
        return (first - timedelta(days=1)).replace(day=1)
    return first


def _occurrence_view(occ: dict, payments: list[dict], task_id: str | None,
                     covers: str | None = None) -> dict:
    amount = _dec(occ.get("amount")) if occ.get("amount") is not None else None
    paid = sum((_dec(p["amount"]) for p in payments), Decimal("0"))
    closed = bool(occ.get("completed_at"))
    pct = _pct(paid, amount) if amount else (100 if closed else 0)
    return {
        "id": str(occ["id"]),
        "period_on": str(occ["period_on"]),
        "due_at": str(occ["due_at"]),
        "amount": _money(amount) if amount is not None else None,
        "paid": _money(paid),
        # A money period shows what was actually paid, even if it was closed
        # by hand short of the amount; a tick-off period is 0 or 100.
        "pct": pct,
        "completed_at": occ.get("completed_at"),
        "closed_reason": occ.get("closed_reason"),
        "task_id": task_id,
        # The month this period is FOR (labels: "Renda de setembro").
        "ref_month": ref_month(_parse_date(occ["period_on"]), covers).isoformat(),
        "payments": [
            {"id": str(p["id"]), "amount": _money(p["amount"]), "paid_on": str(p["paid_on"]),
             "method": p.get("method")}
            for p in payments
        ],
    }


def _routine_view(routine: dict, occurrences: list[dict], payments_by_occ: dict[str, list[dict]],
                  tasks_by_occ: dict[str, str], today: date, history: int = 0) -> dict:
    """A routine with its state now: late, open, done or upcoming."""
    mine = sorted((o for o in occurrences if str(o["routine_id"]) == str(routine["id"])),
                  key=lambda o: str(o["period_on"]))
    open_rows = [o for o in mine if not o.get("completed_at")]
    closed_rows = [o for o in mine if o.get("completed_at")]
    current_row = open_rows[0] if open_rows else (closed_rows[-1] if closed_rows else None)
    covers = routine.get("covers")
    current = (_occurrence_view(current_row, payments_by_occ.get(str(current_row["id"]), []),
                                tasks_by_occ.get(str(current_row["id"])), covers)
               if current_row else None)

    late_days = 0
    if open_rows:
        first_open = _parse_date(open_rows[0]["period_on"])
        late_days = max((today - first_open).days, 0)
    state = "late" if late_days > 0 else ("open" if open_rows else ("done" if closed_rows else "upcoming"))

    schedule = _schedule(routine)
    if open_rows:
        next_on = _parse_date(open_rows[-1]["period_on"])
    elif schedule.on_miss == "from_done" and closed_rows and closed_rows[-1].get("completed_at"):
        next_on = recurrence.after_done(_parse_date(str(closed_rows[-1]["completed_at"])[:10]),
                                        schedule.frequency, schedule.interval_count)
    else:
        last = _parse_date(mine[-1]["period_on"]) if mine else today - timedelta(days=1)
        next_on = recurrence.upcoming(schedule, max(last, today - timedelta(days=1)))[0]

    view = {
        **{k: routine.get(k) for k in (
            "id", "resource_id", "title", "kind", "currency", "direction", "frequency",
            "interval_count", "anchor_on", "due_time", "on_miss", "remind_before_days",
            "remind_on_day", "remind_after_days", "log_to_finance", "finance_category",
            "covers")},
        "amount": _money(routine["amount"]) if routine.get("amount") is not None else None,
        "state": state,
        "late_days": late_days,
        "open_count": len(open_rows),
        "current": current,
        "next_on": next_on.isoformat() if next_on else None,
    }
    if history:
        view["history"] = [
            _occurrence_view(o, payments_by_occ.get(str(o["id"]), []), tasks_by_occ.get(str(o["id"])),
                             covers)
            for o in mine[-history:]
        ]
    return view


async def _context(routines: list[dict], owner_id: UUID, since: date | None = None):
    occurrences = await db.fetch_occurrences_for_routines([str(r["id"]) for r in routines], since)
    occ_ids = [str(o["id"]) for o in occurrences]
    payments_by_occ: dict[str, list[dict]] = {}
    for p in await db.fetch_payments(occ_ids):
        payments_by_occ.setdefault(str(p["occurrence_id"]), []).append(p)
    tasks_by_occ = {str(t["routine_occurrence_id"]): str(t["id"])
                    for t in await db.fetch_tasks_for_occurrences(occ_ids)}
    return occurrences, payments_by_occ, tasks_by_occ


def _resource_view(resource: dict) -> dict:
    return {k: resource.get(k) for k in (
        "id", "cluster_id", "parent_id", "name", "subtitle", "person_name", "since_on", "position")}


def _primary(views: list[dict]) -> dict | None:
    """The routine a unit is summarised by: its first money routine, else its first."""
    return next((v for v in views if v["kind"] == "amount"), views[0] if views else None)


def _month_item(occ: dict, routine: dict, payments: list[dict], resources: dict[str, dict],
                today: date) -> dict:
    """One period as a row of a month's list: who, what, how much, when, how late."""
    period = _parse_date(occ["period_on"])
    closed = bool(occ.get("completed_at"))
    # Paid after the due date? The day the last payment came in says so.
    paid_late_days = 0
    if closed and payments:
        paid_late_days = max((_parse_date(payments[-1]["paid_on"]) - period).days, 0)
    resource = resources.get(str(routine["resource_id"]), {})
    parent = resources.get(str(resource.get("parent_id") or ""), {})
    return {
        **_occurrence_view(occ, payments, None, routine.get("covers")),
        "routine_id": str(routine["id"]),
        "resource_id": str(resource["id"]) if resource.get("id") else None,
        "title": routine["title"],
        "kind": routine["kind"],
        "direction": routine.get("direction") or "income",
        "currency": routine.get("currency") or "EUR",
        "name": resource.get("name"),
        "person": resource.get("person_name"),
        "place": parent.get("name"),
        "late_days": max((today - period).days, 0) if not closed else 0,
        "paid_late_days": paid_late_days,
    }


def owed_before(month_start: date, occurrences: list[dict], payments_by_occ: dict[str, list[dict]],
                routines: list[dict], resources: dict[str, dict], today: date) -> list[dict]:
    """Periods FOR earlier months that are still open — oldest first.

    This month's card counts only this month, so September's unpaid rent
    would vanish from view on 1 October. Listing it separately keeps it in
    sight without mixing it into October's numbers — whether it is a debt
    (Rui, late) or simply not due yet (Marta pays September on 5 October).
    """
    routine_by_id = {str(r["id"]): r for r in routines}
    items = []
    for occ in occurrences:
        routine = routine_by_id.get(str(occ["routine_id"]))
        if routine is None or occ.get("completed_at"):
            continue
        if ref_month(_parse_date(occ["period_on"]), routine.get("covers")) >= month_start:
            continue
        payments = sorted(payments_by_occ.get(str(occ["id"]), []), key=lambda p: str(p["paid_on"]))
        items.append(_month_item(occ, routine, payments, resources, today))
    items.sort(key=lambda i: (i["period_on"], i["name"] or ""))
    return items


def _projected(month_start: date, next_month: date, occurrences: list[dict], routines: list[dict],
               resources: dict[str, dict], today: date) -> list[dict]:
    """Rows for the periods of a month that do not exist yet: due, unpaid, untouched."""
    existing = {(str(o["routine_id"]), str(o["period_on"])[:10]) for o in occurrences}
    rows = []
    for routine in routines:
        # from_done dates depend on when the last one is done: unknowable ahead.
        if routine.get("archived_at") or routine.get("on_miss") == "from_done":
            continue
        schedule = _schedule(routine)
        # The due dates whose period is for this month: this month's own, or
        # next month's when the routine is paid in arrears.
        if routine.get("covers") == "previous_month":
            start, end = next_month, (next_month + timedelta(days=32)).replace(day=1)
        else:
            start, end = month_start, next_month
        n = recurrence.first_index_on_or_after(schedule.anchor_on, schedule.frequency,
                                               schedule.interval_count, max(start, today))
        while True:
            due = recurrence.period_on(schedule.anchor_on, schedule.frequency, schedule.interval_count, n)
            if due >= end:
                break
            n += 1
            if (str(routine["id"]), due.isoformat()) in existing:
                continue
            occ = {"id": f"next-{routine['id']}-{due.isoformat()}", "routine_id": routine["id"],
                   "period_on": due.isoformat(), "due_at": due.isoformat(), "amount": routine.get("amount"),
                   "completed_at": None, "closed_reason": None}
            rows.append({**_month_item(occ, routine, [], resources, today), "scheduled": True})
    return rows


def month_summary(month_start: date, occurrences: list[dict], payments_by_occ: dict[str, list[dict]],
                  routines: list[dict], resources: dict[str, dict], today: date,
                  project: bool = False) -> dict:
    """Everything FOR one month: totals per direction, and each period.

    A month means the month a period is for — September's rent is
    September's even when the tenant pays it on 5 October ("mês anterior").
    So September's total is what September is worth, whatever day it is
    paid on; the row still shows the real due and payment dates.

    project: also list the periods not created yet whose turn falls in this
    month ("Vence a 1 nov"), so a month's total is complete from its first
    day rather than growing as periods appear 10 days before each one.
    Never into the past — a new routine does not back-fill arrears.

    Pure: no I/O, so the same numbers come out wherever it is called from —
    the collection's header for this month, or any month when browsing.
    """
    next_month = (month_start + timedelta(days=32)).replace(day=1)
    routine_by_id = {str(r["id"]): r for r in routines}
    totals = {d: {"target": Decimal(0), "paid": Decimal(0), "count": 0, "done": 0, "late": 0}
              for d in ("income", "expense")}
    items = []
    for occ in occurrences:
        period = _parse_date(occ["period_on"])
        routine = routine_by_id.get(str(occ["routine_id"]))
        if routine is None or ref_month(period, routine.get("covers")) != month_start:
            continue
        payments = sorted(payments_by_occ.get(str(occ["id"]), []), key=lambda p: str(p["paid_on"]))
        item = _month_item(occ, routine, payments, resources, today)
        items.append(item)
        closed = bool(occ.get("completed_at"))
        late_days = item["late_days"]

        if routine["kind"] == "amount":
            bucket = totals[routine.get("direction") or "income"]
            amount = _dec(occ.get("amount"))
            bucket["target"] += amount
            bucket["paid"] += min(sum((_dec(p["amount"]) for p in payments), Decimal(0)), amount)
            bucket["count"] += 1
            bucket["done"] += 1 if closed else 0
            bucket["late"] += 1 if late_days > 0 else 0

    if project:
        for item in _projected(month_start, next_month, occurrences, routines, resources, today):
            items.append(item)
            if item["kind"] == "amount":
                bucket = totals[item["direction"]]
                bucket["target"] += _dec(item["amount"])
                bucket["count"] += 1

    # Late first (they need doing), then by due date, then by name.
    items.sort(key=lambda i: (0 if i["late_days"] > 0 else 1, i["period_on"], i["name"] or ""))
    return {
        "month": month_start.isoformat(),
        "totals": {d: {"target": _money(t["target"]), "paid": _money(t["paid"]),
                       "pct": _pct(t["paid"], t["target"]), "count": t["count"],
                       "done": t["done"], "late": t["late"]}
                   for d, t in totals.items()},
        "items": items,
    }


async def collection_view(cluster_id: UUID, owner_id: UUID) -> dict:
    """Screen 3: the month's totals and a card per resource."""
    cluster = await _owned_collection(cluster_id, owner_id)
    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
    month_start = today.replace(day=1)

    rows = await db.fetch_resources_for_cluster(cluster_id, owner_id)
    routines = await db.fetch_routines_for_resources([str(r["id"]) for r in rows], owner_id)
    occurrences, payments_by_occ, tasks_by_occ = await _context(routines, owner_id,
                                                                since=month_start - timedelta(days=400))
    views = {str(r["id"]): _routine_view(r, occurrences, payments_by_occ, tasks_by_occ, today)
             for r in routines}
    by_resource: dict[str, list[dict]] = {}
    for r in routines:
        by_resource.setdefault(str(r["resource_id"]), []).append(views[str(r["id"])])

    resources_by_id = {str(r["id"]): r for r in rows}
    this_month = month_summary(month_start, occurrences, payments_by_occ, routines,
                               resources_by_id, today, project=True)
    # Months that have anything in them, newest first — what the month
    # arrows can move between. This month is always there, even when empty.
    routine_by_id = {str(r["id"]): r for r in routines}
    months = sorted({ref_month(_parse_date(o["period_on"]), routine_by_id[str(o["routine_id"])].get("covers"))
                     for o in occurrences if str(o["routine_id"]) in routine_by_id} | {month_start},
                    reverse=True)

    late = sum(1 for v in views.values() if v["state"] == "late")
    top = [r for r in rows if not r.get("parent_id")]
    units_by_parent: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("parent_id"):
            units_by_parent.setdefault(str(r["parent_id"]), []).append(r)

    cards = []
    for res in top:
        units = units_by_parent.get(str(res["id"]), [])
        unit_summaries = [
            {**_resource_view(u), "primary": _primary(by_resource.get(str(u["id"]), []))}
            for u in units
        ]
        own = by_resource.get(str(res["id"]), [])
        all_views = own + [v for u in units for v in by_resource.get(str(u["id"]), [])]
        cards.append({
            **_resource_view(res),
            "units": unit_summaries,
            "primary": _primary(own),
            "late": sum(1 for v in all_views if v["state"] == "late"),
            "routine_count": len(own),
        })

    return {
        "cluster": {k: cluster.get(k) for k in ("id", "name", "color", "kind", "is_collection", "collection_noun")},
        "month": month_start.isoformat(),
        "totals": this_month["totals"],
        "items": this_month["items"],
        "owed": owed_before(month_start, occurrences, payments_by_occ, routines, resources_by_id, today),
        "months": [m.isoformat() for m in months],
        "late": late,
        "resources": cards,
    }


async def month_view(cluster_id: UUID, owner_id: UUID, month: date) -> dict:
    """One month of a collection: its totals and every period for it."""
    await _owned_collection(cluster_id, owner_id)
    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
    month_start = month.replace(day=1)
    rows = await db.fetch_resources_for_cluster(cluster_id, owner_id)
    # Archived resources still have history worth showing for past months.
    archived = await db.fetch_archived_resources_for_cluster(cluster_id, owner_id)
    resources_by_id = {str(r["id"]): r for r in rows + archived}
    routines = await db.fetch_all_routines_for_resources(list(resources_by_id), owner_id)
    occurrences, payments_by_occ, _ = await _context(routines, owner_id, since=month_start)
    return month_summary(month_start, occurrences, payments_by_occ, routines, resources_by_id, today,
                         project=True)


async def resource_view(resource_id: UUID, owner_id: UUID) -> dict:
    """Screens 4, 5 and 7: a resource or unit, its units, and routines."""
    resource = await _owned_resource(resource_id, owner_id)
    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))

    units = [] if resource.get("parent_id") else await db.fetch_units(resource_id, owner_id)
    targets = [resource] + units
    routines = await db.fetch_routines_for_resources([str(r["id"]) for r in targets], owner_id)
    occurrences, payments_by_occ, tasks_by_occ = await _context(routines, owner_id)
    views = [_routine_view(r, occurrences, payments_by_occ, tasks_by_occ, today, history=6)
             for r in routines]

    parent = None
    if resource.get("parent_id"):
        p = await db.fetch_resource(UUID(str(resource["parent_id"])), owner_id)
        parent = _resource_view(p) if p else None
    cluster = await db.fetch_cluster(UUID(str(resource["cluster_id"])), owner_id) or {}

    return {
        "resource": _resource_view(resource),
        "parent": parent,
        "cluster": {k: cluster.get(k) for k in ("id", "name", "color", "collection_noun")},
        "routines": [v for v in views if str(v["resource_id"]) == str(resource["id"])],
        "units": [
            {**_resource_view(u),
             "routines": [v for v in views if str(v["resource_id"]) == str(u["id"])],
             "primary": _primary([v for v in views if str(v["resource_id"]) == str(u["id"])])}
            for u in units
        ],
    }


async def routine_view(routine_id: UUID, owner_id: UUID) -> dict:
    """One routine with its current period, payments and recent history."""
    routine = await _owned_routine(routine_id, owner_id)
    prefs = await preferences_for(owner_id)
    today = recurrence.local_today(datetime.now(timezone.utc), prefs.get("timezone"))
    occurrences, payments_by_occ, tasks_by_occ = await _context([routine], owner_id)
    resource = await db.fetch_resource(UUID(str(routine["resource_id"])), owner_id) or {}
    return {
        "routine": _routine_view(routine, occurrences, payments_by_occ, tasks_by_occ, today, history=12),
        "resource": _resource_view(resource) if resource else None,
    }


async def bubble_context(tasks: list[dict]) -> None:
    """Attach `routine` to each period bubble in a task list, in place.

    What the bubble's second line needs: whose period it is and how far it
    is paid ("Marta · 33%"). Two queries for the whole list, not per task.
    """
    occ_ids = [str(t["routine_occurrence_id"]) for t in tasks if t.get("routine_occurrence_id")]
    if not occ_ids:
        return
    rows = await db.fetch_occurrences_with_context(occ_ids)
    paid: dict[str, Decimal] = {}
    for p in await db.fetch_payments(occ_ids):
        paid[str(p["occurrence_id"])] = paid.get(str(p["occurrence_id"]), Decimal(0)) + _dec(p["amount"])
    by_id = {str(r["id"]): r for r in rows}
    for task in tasks:
        occ = by_id.get(str(task.get("routine_occurrence_id") or ""))
        if not occ:
            continue
        routine = occ.get("collection_routines") or {}
        resource = routine.get("collection_resources") or {}
        amount = _dec(occ.get("amount")) if occ.get("amount") is not None else None
        got = paid.get(str(occ["id"]), Decimal(0))
        task["routine"] = {
            "occurrence_id": str(occ["id"]),
            "routine_id": str(occ["routine_id"]),
            "resource_id": resource.get("id"),
            "kind": routine.get("kind"),
            "direction": routine.get("direction"),
            "person": resource.get("person_name") or resource.get("name"),
            "amount": _money(amount) if amount is not None else None,
            "paid": _money(got),
            "pct": _pct(got, amount) if amount else None,
            "currency": routine.get("currency") or "EUR",
            "period_on": str(occ["period_on"]),
            # The house a room is in ("Casa 1"), or the resource itself.
            "place": (resource.get("parent") or {}).get("name") or resource.get("name"),
        }
