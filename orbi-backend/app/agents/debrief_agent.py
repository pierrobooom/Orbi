"""Debrief agent — conducts post-event conversations and extracts structured data.

Guides the user through a short debrief after meetings or events, then extracts
action items, decisions, key facts, and follow-ups into structured output.
"""

import json
import logging
from uuid import UUID

from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("debrief_agent")


async def continue_debrief(
    user_message: str,
    conversation_history: list[dict],
    user_id: UUID,
    user_tier: str,
) -> dict:
    """Process the next message in a debrief conversation.

    The debrief agent operates in two modes:
    1. Conversational — asking follow-up questions to extract details.
    2. Extraction — when enough info is gathered, producing structured output.

    Args:
        user_message:         The user's latest message.
        conversation_history: Full debrief conversation so far.
        user_tier:            Subscription tier for AI routing.

    Returns:
        {
            "response": str,       # Next message to show the user
            "is_complete": bool,   # True when extraction is done
            "extraction": dict | None  # Structured data if is_complete
        }
    """
    history_text = "\n".join(
        f"{msg['role']}: {msg['content']}" for msg in conversation_history
    )

    prompt = (
        f"Conversation so far:\n{history_text}\n\n"
        f"User's latest message: {user_message}\n\n"
        "If you have enough information to produce a structured extraction, "
        "respond with a JSON object containing both 'response' (your final message "
        "to the user) and 'extraction' (the structured data). "
        "If you need more information, respond with just your next conversational "
        "message as plain text (not JSON)."
    )

    # Debrief is one of the Claude-eligible intents on the Genius tier — see
    # ai_router._CLAUDE_INTENTS. Free/Pro users still hit Llama via the router.
    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent="debrief",
        max_tokens=800,
    )

    # Try to parse as JSON (extraction mode)
    try:
        result = json.loads(raw)
        if "extraction" in result:
            return {
                "response": result.get("response", "Got it, here's what I captured."),
                "is_complete": True,
                "extraction": result["extraction"],
            }
    except (json.JSONDecodeError, ValueError):
        pass

    # Conversational mode — raw text is the agent's next question/response
    return {
        "response": raw,
        "is_complete": False,
        "extraction": None,
    }
