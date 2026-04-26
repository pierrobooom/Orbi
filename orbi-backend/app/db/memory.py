"""Database queries for MemoryNode with pgvector semantic search.

All functions interact directly with Supabase. Vector similarity search
uses the pgvector extension via Supabase's RPC functions.
"""

from uuid import UUID

from app.db.client import get_client


async def fetch_memories_for_user(
    user_id: UUID,
    memory_type: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Return memory nodes for the user, optionally filtered by type.

    Args:
        user_id:     Owner of the memories.
        memory_type: Filter by memory type (fact, decision, pattern, summary).
        limit:       Max number of records to return.
    """
    query = (
        get_client().table("memory_nodes")
        .select("*")
        .eq("user_id", str(user_id))
        .order("updated_at", desc=True)
        .limit(limit)
    )

    if memory_type:
        query = query.eq("memory_type", memory_type)

    response = query.execute()
    return response.data or []


async def fetch_memory_by_id(memory_id: UUID, user_id: UUID) -> dict | None:
    """Return a single memory node, or None if not found."""
    response = (
        get_client().table("memory_nodes")
        .select("*")
        .eq("id", str(memory_id))
        .eq("user_id", str(user_id))
        .single()
        .execute()
    )
    return response.data


async def insert_memory(payload: dict) -> dict:
    """Insert a new memory node and return the created record."""
    response = get_client().table("memory_nodes").insert(payload).execute()
    return response.data[0]


async def update_memory(memory_id: UUID, user_id: UUID, payload: dict) -> dict | None:
    """Update a memory node. Returns the updated record or None."""
    response = (
        get_client().table("memory_nodes")
        .update(payload)
        .eq("id", str(memory_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return response.data[0] if response.data else None


async def delete_memory(memory_id: UUID, user_id: UUID) -> bool:
    """Delete a memory node. Returns True on success."""
    response = (
        get_client().table("memory_nodes")
        .delete()
        .eq("id", str(memory_id))
        .eq("user_id", str(user_id))
        .execute()
    )
    return bool(response.data)


async def search_memories_by_embedding(
    user_id: UUID,
    query_embedding: list[float],
    match_count: int = 10,
    match_threshold: float = 0.7,
) -> list[dict]:
    """Semantic similarity search over memory nodes using pgvector.

    Calls a Supabase RPC function that performs cosine similarity search.
    The function must be created in Supabase SQL:

        create or replace function match_memories(
            p_user_id uuid,
            p_embedding vector(1024),
            p_match_count int default 10,
            p_match_threshold float default 0.7
        ) returns table (
            id uuid,
            user_id uuid,
            content text,
            memory_type text,
            tags text[],
            importance int,
            source_summary text,
            similarity float
        )
        language plpgsql as $$
        begin
            return query
            select
                mn.id, mn.user_id, mn.content, mn.memory_type,
                mn.tags, mn.importance, mn.source_summary,
                1 - (mn.embedding <=> p_embedding) as similarity
            from memory_nodes mn
            where mn.user_id = p_user_id
              and 1 - (mn.embedding <=> p_embedding) > p_match_threshold
            order by mn.embedding <=> p_embedding
            limit p_match_count;
        end;
        $$;

    Args:
        user_id:          Owner of the memories to search.
        query_embedding:  The embedding vector of the search query.
        match_count:      Maximum number of results.
        match_threshold:  Minimum similarity score (0-1) to include.

    Returns:
        List of memory dicts with an added 'similarity' field, ordered by relevance.
    """
    response = (
        get_client().rpc(
            "match_memories",
            {
                "p_user_id": str(user_id),
                "p_embedding": query_embedding,
                "p_match_count": match_count,
                "p_match_threshold": match_threshold,
            },
        ).execute()
    )
    return response.data or []


async def store_embedding(memory_id: UUID, embedding: list[float]) -> bool:
    """Store an embedding vector for a memory node.

    Updates the embedding column on an existing memory_nodes row.
    """
    response = (
        get_client().table("memory_nodes")
        .update({"embedding": embedding})
        .eq("id", str(memory_id))
        .execute()
    )
    return bool(response.data)
