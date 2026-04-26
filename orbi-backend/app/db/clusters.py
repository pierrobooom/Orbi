"""Database queries for Cluster.

All functions interact directly with Supabase. No business logic lives here.
"""

from uuid import UUID

from app.db.client import get_client


async def fetch_clusters_for_user(user_id: UUID) -> list[dict]:
    """Return all clusters owned by user_id, ordered by weight_score desc."""
    response = (
        get_client().table("clusters")
        .select("*")
        .eq("owner_id", str(user_id))
        .order("weight_score", desc=True)
        .execute()
    )
    return response.data or []


async def fetch_cluster_by_id(cluster_id: UUID, owner_id: UUID) -> dict | None:
    """Return a single cluster owned by owner_id, or None if not found."""
    response = (
        get_client().table("clusters")
        .select("*")
        .eq("id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .single()
        .execute()
    )
    return response.data


async def insert_cluster(payload: dict) -> dict:
    """Insert a new cluster and return the created record."""
    response = get_client().table("clusters").insert(payload).execute()
    return response.data[0]


async def update_cluster(cluster_id: UUID, owner_id: UUID, payload: dict) -> dict | None:
    """Apply a partial update to a cluster. Returns the updated record or None."""
    response = (
        get_client().table("clusters")
        .update(payload)
        .eq("id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return response.data[0] if response.data else None


async def delete_cluster(cluster_id: UUID, owner_id: UUID) -> bool:
    """Delete a cluster. Returns True on success.

    Tasks referencing this cluster should have their parent_cluster_id set to null
    before calling this, or rely on the DB cascade/nullify constraint.
    """
    response = (
        get_client().table("clusters")
        .delete()
        .eq("id", str(cluster_id))
        .eq("owner_id", str(owner_id))
        .execute()
    )
    return bool(response.data)
