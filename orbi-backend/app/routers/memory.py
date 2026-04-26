"""Memory router — endpoints for memory nodes and semantic search.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.db import memory as memory_db
from app.models.memory import MemoryNode, MemoryNodeCreate
from app.services.auth import get_current_user
from app.services.embeddings import generate_embedding

router = APIRouter(prefix="/memory", tags=["memory"])


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


@router.get("", response_model=list[MemoryNode])
async def list_memories(
    user_id: UUID = Depends(get_current_user),
    memory_type: str | None = Query(default=None, description="Filter by type: fact, decision, pattern, summary"),
    limit: int = Query(default=50, ge=1, le=200),
):
    """Return memory nodes for the authenticated user."""
    return await memory_db.fetch_memories_for_user(user_id, memory_type=memory_type, limit=limit)


@router.post("", response_model=MemoryNode, status_code=status.HTTP_201_CREATED)
async def create_memory(
    body: MemoryNodeCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create a new memory node and generate its embedding."""
    now = datetime.now(timezone.utc)
    memory_id = uuid4()

    payload = {
        "id": str(memory_id),
        "user_id": str(user_id),
        "content": body.content,
        "memory_type": body.memory_type,
        "tags": body.tags,
        "importance": body.importance,
        "source_summary": body.source_summary,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }

    row = await memory_db.insert_memory(payload)

    # Generate and store embedding asynchronously — don't block the response
    embedding = await generate_embedding(body.content)
    if embedding:
        await memory_db.store_embedding(memory_id, embedding)

    return row


@router.get("/search")
async def search_memories(
    q: str = Query(..., description="Natural language search query"),
    user_id: UUID = Depends(get_current_user),
    limit: int = Query(default=10, ge=1, le=50),
):
    """Semantic search over memory nodes using vector similarity.

    Generates an embedding for the query text and searches the user's
    memory nodes for the closest matches.
    """
    embedding = await generate_embedding(q)
    if embedding is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Embedding service unavailable. Try again later.",
                "EMBEDDING_SERVICE_DOWN",
            ),
        )

    results = await memory_db.search_memories_by_embedding(
        user_id=user_id,
        query_embedding=embedding,
        match_count=limit,
    )
    return results


@router.get("/{memory_id}", response_model=MemoryNode)
async def get_memory(memory_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Fetch a single memory node by ID."""
    row = await memory_db.fetch_memory_by_id(memory_id, user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Memory node not found.", "MEMORY_NOT_FOUND"),
        )
    return row


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(memory_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Delete a memory node."""
    success = await memory_db.delete_memory(memory_id, user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Memory node not found.", "MEMORY_NOT_FOUND"),
        )
