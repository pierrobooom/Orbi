"""Reminder planner agent — decides when and how to notify users about their tasks.

Given a user's active tasks, preferences, and current time, determines which
notifications to schedule and with what urgency.
"""

import json
import logging
from datetime import datetime, timezone

from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("reminder_planner")


async def plan_reminders(
    active_tasks: list[dict],
    user_preferences: dict,
    user_tier: str,
) -> list[dict]:
    """Determine which notifications to send for the user's active tasks.

    Args:
        active_tasks:     List of active TaskBubble dicts with pressure scores.
        user_preferences: Dict with quiet_hours_start, quiet_hours_end, proactivity_level.
        user_tier:        Subscription tier for AI routing.

    Returns:
        List of notification plan dicts with keys:
        task_id, trigger_at, reason, message, urgency, channel.
        Returns an empty list on failure or if no reminders are warranted.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    prompt = (
        f"Current time: {now}\n"
        f"User preferences: {json.dumps(user_preferences)}\n\n"
        f"Active tasks:\n{json.dumps(active_tasks)}"
    )

    raw = await get_ai_response(
        prompt=prompt,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        max_tokens=600,
    )

    try:
        result = json.loads(raw)
        if not isinstance(result, list):
            raise ValueError("Expected a JSON array of notification plans")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Reminder planner failed: %s | raw=%s", exc, raw[:200])
        return []
