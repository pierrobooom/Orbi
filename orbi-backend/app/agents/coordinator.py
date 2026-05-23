"""Coordinator agent — routes user intent to the correct specialist agent.

The coordinator is the entry point for all user messages. It classifies the
intent using AI, then delegates to the appropriate agent or returns a direct
response for simple queries.
"""

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.agents._utils import strip_json_fences
from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("coordinator")


async def classify_intent(
    user_message: str,
    user_id: UUID,
    user_tier: str,
    conversation_history: list[dict] | None = None,
) -> dict:
    """Classify the user's intent and determine which agent should handle it.

    Args:
        user_message:         The raw user input (voice transcript or typed text).
        user_tier:            Subscription tier for AI routing.
        conversation_history: Recent messages for context continuity.

    Returns:
        A dict with keys: intent, confidence, agent, context_needed, response_to_user.
        Falls back to general_chat with a clarification prompt on failure.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    context_lines = [f"Current date/time: {now}"]

    if conversation_history:
        recent = conversation_history[-5:]
        history_text = "\n".join(
            f"{msg['role']}: {msg['content']}" for msg in recent
        )
        context_lines.append(f"Recent conversation:\n{history_text}")

    system = _SYSTEM_PROMPT + "\n\n" + "\n".join(context_lines)

    # Bumped from 300 — the embedded task-extraction `data` field added
    # in coordinator_v1.md needs room to land its fields.
    raw = await get_ai_response(
        prompt=user_message,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=system,
        intent="daily_chat",
        max_tokens=600,
    )

    try:
        result = json.loads(strip_json_fences(raw))
        required_keys = {"intent", "confidence", "agent"}
        if not required_keys.issubset(result.keys()):
            raise ValueError(f"Missing keys: {required_keys - result.keys()}")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Coordinator failed to parse AI response: %s | raw=%s", exc, raw[:200])
        return {
            "intent": "general_chat",
            "confidence": 0.3,
            "agent": None,
            "context_needed": [],
            "response_to_user": raw if len(raw) < 500 else "I'm not sure what you need. Could you rephrase that?",
        }
