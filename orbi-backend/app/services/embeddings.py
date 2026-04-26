"""Embedding generation service.

Generates vector embeddings for text content using Groq's API.
Embeddings are stored in pgvector for semantic similarity search.
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
_EMBEDDING_MODEL = "llama-3.1-8b-instant"
_EMBEDDING_DIMENSION = 1024

# Groq does not yet have a dedicated embeddings endpoint, so we use
# a lightweight external provider as a fallback. This can be swapped
# to any OpenAI-compatible embeddings API.
_EMBEDDING_URL = os.environ.get(
    "EMBEDDING_API_URL",
    "https://api.groq.com/openai/v1/embeddings",
)


async def generate_embedding(text: str) -> list[float] | None:
    """Generate a vector embedding for the given text.

    Returns a list of floats (the embedding vector), or None on failure.
    Errors are logged but never raised — callers should handle None gracefully.
    """
    if not _GROQ_API_KEY:
        logger.error("GROQ_API_KEY not set — cannot generate embeddings")
        return None

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                _EMBEDDING_URL,
                headers={
                    "Authorization": f"Bearer {_GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": _EMBEDDING_MODEL,
                    "input": text,
                },
            )
            response.raise_for_status()
            data = response.json()
            return data["data"][0]["embedding"]
    except Exception as exc:
        logger.error("Embedding generation failed: %s", exc)
        return None


def get_embedding_dimension() -> int:
    """Return the expected dimension of the embedding vectors."""
    return _EMBEDDING_DIMENSION
