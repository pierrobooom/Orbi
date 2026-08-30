"""Memory summarizer agent — extracts and condenses long-term memory nodes.

Creates discrete memory nodes from conversations, synthesises periodic summaries,
and answers queries about past decisions and facts.
"""

import json
import logging
from uuid import UUID

from app.agents._utils import strip_json_fences
from app.services.context_budget import render_records
from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("memory_summarizer")


# `embedding` is by far the largest column on a memory row — 1024 floats
# serialise to roughly 12KB of JSON each, so a handful of rows could
# exhaust the context window on their own. Field-stripping is not a
# nicety here, it is the difference between working and not.
_MEMORY_FIELDS = ("id", "node_type", "content", "created_at")
_SUMMARY_BUDGET = 2200
_QUERY_BUDGET = 1800
_MAX_NODES = 40


async def extract_memories(
    conversation_transcript: str,
    source_summary: str,
    user_id: UUID,
    user_tier: str,
) -> list[dict]:
    """Extract discrete memory nodes from a conversation transcript.

    Args:
        conversation_transcript: The full text of the conversation.
        source_summary:          Brief description of where this came from.
        user_tier:               Subscription tier for AI routing.

    Returns:
        List of memory node dicts with keys:
        content, memory_type, tags, importance, source_summary.
        Returns an empty list on failure.
    """
    prompt = (
        f"Extract memory nodes from this conversation.\n"
        f"Source: {source_summary}\n\n"
        f"Transcript:\n{conversation_transcript}"
    )

    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent="daily_chat",
        max_tokens=800,
    )

    try:
        result = json.loads(strip_json_fences(raw))
        if not isinstance(result, list):
            raise ValueError("Expected a JSON array of memory nodes")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Memory extraction failed: %s | raw=%s", exc, raw[:200])
        return []


async def synthesise_summary(
    memory_nodes: list[dict],
    period: str,
    user_id: UUID,
    user_tier: str,
    intent: str = "weekly_review",
) -> dict:
    """Produce a higher-level summary from a set of memory nodes.

    Args:
        memory_nodes: Memory nodes from the period to summarise.
        period:       Human-readable period label (e.g. "Week of Apr 21-27, 2026").
        user_id:      Authenticated user — for quota tracking.
        user_tier:    Subscription tier for AI routing.
        intent:       'weekly_review' or 'monthly_synthesis' — the caller picks
                      based on cadence. Both are Genius Claude-eligible.

    Returns:
        {"summary": str, "key_themes": list[str], "unresolved": list[str]}
    """
    prompt = (
        f"Synthesise a summary for: {period}\n\n"
        "Memory nodes:\n"
        + render_records(
            memory_nodes,
            _MEMORY_FIELDS,
            max_tokens=_SUMMARY_BUDGET,
            max_records=_MAX_NODES,
            label="memories",
        )
    )

    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent=intent,
        max_tokens=600,
    )

    try:
        result = json.loads(strip_json_fences(raw))
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Memory synthesis failed: %s | raw=%s", exc, raw[:200])
        return {"summary": "", "key_themes": [], "unresolved": []}


async def answer_memory_query(
    question: str,
    relevant_memories: list[dict],
    user_id: UUID,
    user_tier: str,
) -> str:
    """Answer a user's question using retrieved memory nodes.

    Args:
        question:           The user's question about past events or decisions.
        relevant_memories:  Memory nodes retrieved by semantic search.
        user_tier:          Subscription tier for AI routing.

    Returns:
        A plain-English answer grounded in the provided memories.
    """
    prompt = (
        f"User question: {question}\n\n"
        "Relevant memories:\n"
        + render_records(
            relevant_memories,
            _MEMORY_FIELDS,
            max_tokens=_QUERY_BUDGET,
            max_records=_MAX_NODES,
            label="memories",
        )
    )

    return await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent="daily_chat",
        max_tokens=400,
    )
