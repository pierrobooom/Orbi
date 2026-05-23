"""Task parser agent — converts natural language into structured TaskBubble fields.

Takes raw user input (voice transcript or typed text) and extracts structured
task data: title, description, due date, importance, domain, and confidence.
"""

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.agents._utils import strip_json_fences
from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("task_parser")


async def parse_task(
    user_input: str,
    user_id: UUID,
    user_tier: str,
    current_date: str | None = None,
) -> dict:
    """Parse natural language into structured task fields.

    Args:
        user_input:   Raw text from voice transcription or typed input.
        user_tier:    Subscription tier for AI routing.
        current_date: ISO date string for resolving relative dates. Defaults to today.

    Returns:
        A dict with keys: title, description, due_at, importance, domain_hint, confidence.
        Returns a low-confidence fallback if parsing fails.
    """
    if current_date is None:
        current_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    system = _SYSTEM_PROMPT + f"\n\nCurrent date: {current_date}"

    raw = await get_ai_response(
        prompt=user_input,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=system,
        intent="daily_chat",
        max_tokens=400,
    )

    try:
        result = json.loads(strip_json_fences(raw))
        # Validate required fields exist
        if "title" not in result:
            raise ValueError("Missing 'title' in parsed result")
        # Clamp importance to valid range
        result["importance"] = max(1, min(10, result.get("importance", 5)))
        # Clamp confidence to valid range
        result["confidence"] = max(0.0, min(1.0, result.get("confidence", 0.5)))
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Task parser failed: %s | raw=%s", exc, raw[:200])
        return {
            "title": user_input[:80],
            "description": None,
            "due_at": None,
            "importance": 5,
            "domain_hint": None,
            "confidence": 0.2,
        }
