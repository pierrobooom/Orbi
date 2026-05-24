"""Embedding generation service.

Uses OpenAI's text-embedding-3-small model with dimensions=1024 so the
output fits the existing pgvector(1024) columns on task_bubbles and
memory_nodes without a schema change. OpenAI bills per-token; at
~30 tokens per task, generating an embedding costs roughly 6e-7 USD.

Callers expect None on failure (network blip, missing key, etc.) and
should handle that gracefully — search will just return nothing for
that task rather than crashing the create/update path. We never raise
from this module.

Env vars:
  OPENAI_API_KEY  required — OpenAI dashboard → API keys
  EMBEDDING_API_URL  optional override; defaults to OpenAI's endpoint
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

# text-embedding-3-small natively returns 1536 dims; we request 1024
# via the dimensions parameter (OpenAI truncates + renormalises the
# vector for us) so the result fits our pgvector columns. Switching
# to text-embedding-3-large would be a one-line model swap if recall
# ever becomes a problem.
_EMBEDDING_MODEL = "text-embedding-3-small"
_EMBEDDING_DIMENSION = 1024

_EMBEDDING_URL = os.environ.get(
    "EMBEDDING_API_URL",
    "https://api.openai.com/v1/embeddings",
)


async def generate_embedding(text: str) -> list[float] | None:
    """Return a 1024-dim embedding vector for the given text.

    Returns None on any failure — caller decides what to do. We log
    the error so it surfaces in uvicorn output without crashing.
    """
    if not _OPENAI_API_KEY:
        logger.error("OPENAI_API_KEY not set — cannot generate embeddings")
        return None

    cleaned = (text or "").strip()
    if not cleaned:
        return None

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                _EMBEDDING_URL,
                headers={
                    "Authorization": f"Bearer {_OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": _EMBEDDING_MODEL,
                    "input": cleaned,
                    "dimensions": _EMBEDDING_DIMENSION,
                },
            )
            response.raise_for_status()
            data = response.json()
            return data["data"][0]["embedding"]
    except Exception as exc:  # noqa: BLE001 — never raise out
        logger.error("Embedding generation failed: %s", exc)
        return None


def get_embedding_dimension() -> int:
    """Return the expected dimension of the embedding vectors."""
    return _EMBEDDING_DIMENSION
