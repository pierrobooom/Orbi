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

# v2 emits data.tasks as an array so one utterance can produce several
# tasks ("book the dentist, call mum, buy milk").
_SYSTEM_PROMPT = load_prompt("coordinator", version=2)


async def classify_intent(
    user_message: str,
    user_id: UUID,
    user_tier: str,
    conversation_history: list[dict] | None = None,
    user_timezone: str | None = None,
    language: str | None = None,
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
    now_utc = datetime.now(timezone.utc)
    context_lines = [f"Current date/time: {now_utc.strftime('%Y-%m-%d %H:%M UTC')}"]

    # When the client tells us its IANA timezone, surface it to the LLM
    # so it interprets "4 PM" as 4 PM in the user's local zone rather
    # than UTC. Also pass the user's wall-clock time so the model has
    # both reference points and can compute relative times accurately.
    if user_timezone:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(user_timezone)
            local_now = now_utc.astimezone(tz)
            context_lines.append(
                f"User's timezone: {user_timezone}\n"
                f"User's local time: {local_now.strftime('%Y-%m-%d %H:%M %Z (UTC%z)')}\n"
                f"When the user mentions a time like \"4 PM\", interpret it "
                f"as their LOCAL time and convert to UTC for due_at."
            )
        except Exception:  # noqa: BLE001 — bad tz string isn't worth crashing on
            pass

    if conversation_history:
        recent = conversation_history[-5:]
        history_text = "\n".join(
            f"{msg['role']}: {msg['content']}" for msg in recent
        )
        context_lines.append(f"Recent conversation:\n{history_text}")

    # The prompt is written in English, so without an explicit
    # instruction the model replies in English even when the user spoke
    # Portuguese. The locale supplies that instruction.
    from app.services.locale import get_locale

    context_lines.append(get_locale(language).prompt_instruction)

    system = _SYSTEM_PROMPT + "\n\n" + "\n".join(context_lines)

    # Bumped from 300 — the embedded task-extraction `data` field added
    # in coordinator_v1.md needs room to land its fields. Bumped again for
    # v2's multi-task array: three tasks plus the GPT-OSS reasoning pass
    # overflowed 600 and came back as truncated, unparseable JSON.
    raw = await get_ai_response(
        prompt=user_message,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=system,
        intent="daily_chat",
        max_tokens=1400,
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
