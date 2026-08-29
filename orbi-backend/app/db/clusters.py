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
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


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


async def update_cluster_embedding(
    cluster_id: str | UUID,
    embedding: list[float],
    embedding_source: str,
) -> None:
    """Cache a cluster's embedding alongside the text that produced it.

    embedding_source is what lets the matcher tell a fresh vector from a
    stale one after a rename, so we re-embed once instead of on every
    match. Owner scoping is unnecessary here — the id came from a row we
    already fetched for this user.
    """
    (
        get_client().table("clusters")
        .update({"embedding": embedding, "embedding_source": embedding_source})
        .eq("id", str(cluster_id))
        .execute()
    )


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
