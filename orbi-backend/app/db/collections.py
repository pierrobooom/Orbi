"""Database queries for collections: resources, routines, occurrences, payments.

No business logic lives here — what a period is and when it exists is decided
in services/recurrence.py, and what to do about it in services/collections.py.
Every query is scoped by owner_id; the service role bypasses RLS, so this is
the layer that keeps one person's data from another.
"""

from datetime import date, datetime, timezone
from uuid import UUID

from app.db.client import get_client


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------

async def fetch_cluster(cluster_id: UUID, owner_id: UUID) -> dict | None:
    rows = (
        get_client().table("clusters")
        .select("id,owner_id,name,color,kind,is_collection,collection_noun")
        .eq("id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def set_cluster_collection(cluster_id: UUID, owner_id: UUID, is_collection: bool,
                                 noun: str | None) -> dict | None:
    rows = (
        get_client().table("clusters")
        .update({"is_collection": is_collection, "collection_noun": noun})
        .eq("id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Resources and units
# ---------------------------------------------------------------------------

async def fetch_resource(resource_id: UUID, owner_id: UUID) -> dict | None:
    rows = (
        get_client().table("collection_resources")
        .select("*")
        .eq("id", str(resource_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def fetch_resources_for_cluster(cluster_id: UUID, owner_id: UUID) -> list[dict]:
    """Every live resource AND unit in a collection, in display order."""
    return (
        get_client().table("collection_resources")
        .select("*")
        .eq("cluster_id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .is_("archived_at", "null")
        .order("position")
        .order("created_at")
        .execute()
        .data
        or []
    )


async def fetch_archived_resources_for_cluster(cluster_id: UUID, owner_id: UUID) -> list[dict]:
    """Archived resources and units: their past months are still history."""
    return (
        get_client().table("collection_resources")
        .select("*")
        .eq("cluster_id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .not_.is_("archived_at", "null")
        .execute()
        .data
        or []
    )


async def fetch_all_routines_for_resources(resource_ids: list[str], owner_id: UUID) -> list[dict]:
    """Routines INCLUDING archived ones — for history, never for scheduling."""
    if not resource_ids:
        return []
    return (
        get_client().table("collection_routines")
        .select("*")
        .in_("resource_id", resource_ids)
        .eq("owner_id", str(owner_id))
        .execute()
        .data
        or []
    )


async def fetch_units(resource_id: UUID, owner_id: UUID) -> list[dict]:
    return (
        get_client().table("collection_resources")
        .select("*")
        .eq("parent_id", str(resource_id))
        .eq("owner_id", str(owner_id))
        .is_("archived_at", "null")
        .order("position")
        .order("created_at")
        .execute()
        .data
        or []
    )


async def count_top_level_resources(owner_id: UUID) -> int:
    response = (
        get_client().table("collection_resources")
        .select("id", count="exact")
        .eq("owner_id", str(owner_id))
        .is_("parent_id", "null")
        .is_("archived_at", "null")
        .execute()
    )
    return response.count or 0


async def insert_resource(payload: dict) -> dict:
    return get_client().table("collection_resources").insert(payload).execute().data[0]


async def update_resource(resource_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    rows = (
        get_client().table("collection_resources")
        .update({**payload, "updated_at": _now_iso()})
        .eq("id", str(resource_id))
        .eq("owner_id", str(owner_id))
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Routines
# ---------------------------------------------------------------------------

async def fetch_routine(routine_id: UUID, owner_id: UUID) -> dict | None:
    rows = (
        get_client().table("collection_routines")
        .select("*")
        .eq("id", str(routine_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def fetch_routines_for_resources(resource_ids: list[str], owner_id: UUID) -> list[dict]:
    if not resource_ids:
        return []
    return (
        get_client().table("collection_routines")
        .select("*")
        .in_("resource_id", resource_ids)
        .eq("owner_id", str(owner_id))
        .is_("archived_at", "null")
        .order("position")
        .order("created_at")
        .execute()
        .data
        or []
    )


async def fetch_live_routines(owner_id: UUID | None = None) -> list[dict]:
    """Every live routine — for one owner, or for everyone (the scheduler)."""
    query = get_client().table("collection_routines").select("*").is_("archived_at", "null")
    if owner_id is not None:
        query = query.eq("owner_id", str(owner_id))
    return query.execute().data or []


async def insert_routine(payload: dict) -> dict:
    return get_client().table("collection_routines").insert(payload).execute().data[0]


async def update_routine(routine_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    rows = (
        get_client().table("collection_routines")
        .update({**payload, "updated_at": _now_iso()})
        .eq("id", str(routine_id))
        .eq("owner_id", str(owner_id))
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Occurrences
# ---------------------------------------------------------------------------

async def fetch_occurrence(occurrence_id: UUID, owner_id: UUID) -> dict | None:
    rows = (
        get_client().table("routine_occurrences")
        .select("*")
        .eq("id", str(occurrence_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def fetch_occurrences_for_routines(routine_ids: list[str], since: date | None = None) -> list[dict]:
    """Occurrences of these routines, newest period first."""
    if not routine_ids:
        return []
    query = (
        get_client().table("routine_occurrences")
        .select("*")
        .in_("routine_id", routine_ids)
    )
    if since is not None:
        query = query.gte("period_on", since.isoformat())
    return query.order("period_on", desc=True).execute().data or []


async def fetch_open_occurrences(routine_id: UUID) -> list[dict]:
    return (
        get_client().table("routine_occurrences")
        .select("*")
        .eq("routine_id", str(routine_id))
        .is_("completed_at", "null")
        .order("period_on")
        .execute()
        .data
        or []
    )


async def fetch_latest_closed(routine_id: UUID) -> dict | None:
    rows = (
        get_client().table("routine_occurrences")
        .select("*")
        .eq("routine_id", str(routine_id))
        .not_.is_("completed_at", "null")
        .order("period_on", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def insert_occurrence(payload: dict) -> dict | None:
    """Insert one period, or return None if it already exists.

    The unique (routine_id, period_on) key makes creation idempotent: two
    passes racing to create October both succeed, and there is one October.
    """
    rows = (
        get_client().table("routine_occurrences")
        .upsert(payload, on_conflict="routine_id,period_on", ignore_duplicates=True)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def fetch_occurrence_by_period(routine_id: UUID, period_on: date) -> dict | None:
    rows = (
        get_client().table("routine_occurrences")
        .select("*")
        .eq("routine_id", str(routine_id))
        .eq("period_on", period_on.isoformat())
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def update_occurrence(occurrence_id: UUID, payload: dict) -> dict | None:
    rows = (
        get_client().table("routine_occurrences")
        .update(payload)
        .eq("id", str(occurrence_id))
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def delete_occurrence(occurrence_id: UUID) -> None:
    get_client().table("routine_occurrences").delete().eq("id", str(occurrence_id)).execute()


async def fetch_occurrences_with_context(occurrence_ids: list[str]) -> list[dict]:
    """Occurrences with their routine, resource and (for a unit) its parent —
    everything a bubble needs to say whose period it is."""
    if not occurrence_ids:
        return []
    return (
        get_client().table("routine_occurrences")
        .select(
            "id,amount,period_on,routine_id,"
            "collection_routines(id,title,kind,direction,currency,resource_id,"
            "collection_resources(id,name,person_name,parent_id,parent:parent_id(name)))"
        )
        .in_("id", occurrence_ids)
        .execute()
        .data
        or []
    )


# ---------------------------------------------------------------------------
# Tasks that belong to occurrences
# ---------------------------------------------------------------------------

async def fetch_tasks_for_occurrences(occurrence_ids: list[str]) -> list[dict]:
    if not occurrence_ids:
        return []
    return (
        get_client().table("task_bubbles")
        .select("id,status,routine_occurrence_id,title,label")
        .in_("routine_occurrence_id", occurrence_ids)
        .execute()
        .data
        or []
    )


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------

async def fetch_payments(occurrence_ids: list[str]) -> list[dict]:
    if not occurrence_ids:
        return []
    return (
        get_client().table("routine_payments")
        .select("*")
        .in_("occurrence_id", occurrence_ids)
        .order("paid_on")
        .order("created_at")
        .execute()
        .data
        or []
    )


async def fetch_payment(payment_id: UUID, owner_id: UUID) -> dict | None:
    rows = (
        get_client().table("routine_payments")
        .select("*")
        .eq("id", str(payment_id))
        .eq("owner_id", str(owner_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def insert_payment(payload: dict) -> dict:
    return get_client().table("routine_payments").insert(payload).execute().data[0]


async def update_payment(payment_id: UUID, payload: dict) -> None:
    get_client().table("routine_payments").update(payload).eq("id", str(payment_id)).execute()


async def delete_payment(payment_id: UUID, owner_id: UUID) -> None:
    (
        get_client().table("routine_payments")
        .delete()
        .eq("id", str(payment_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
