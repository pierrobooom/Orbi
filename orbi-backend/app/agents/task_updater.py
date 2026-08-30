"""Task updater agent — applies a natural-language update to an existing task.

The user already has a task and says something like "move that to Tuesday"
or "actually it's the council tax". This agent diffs the spoken instruction
against the current task state and returns just the fields that should
change, plus a short confirmation reply.

Unlike task_parser, this returns a sparse patch — only the fields the user
asked to change. The chat / router that calls this is responsible for
applying the patch via the existing PATCH /api/v1/tasks/{id} path.
"""

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from app.agents._utils import strip_json_fences
from app.services.ai_router import get_ai_response, load_prompt
from app.services.task_sanitizer import _parse_due_at
from app.services.time_extractor import override_due_at_clock

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("task_updater")

# Fields we permit the LLM to change via voice. parent_cluster_id is
# intentionally excluded — that's the auto-clustering agent's job.
_ALLOWED_PATCH_FIELDS = frozenset({
    "title", "label", "description", "due_at", "importance",
})


async def parse_voice_update(
    *,
    current_task: dict,
    user_message: str,
    user_id: UUID,
    user_tier: str,
    user_timezone: str | None = None,
    language: str | None = None,
) -> dict:
    """Return a {patch, reply} dict — patch contains only changed fields.

    Args:
        current_task: dict shape mirrors TaskBubble — title/label/description
                      /due_at/importance/status. Only the fields the LLM
                      needs are forwarded into the prompt.
        user_message: the transcribed user instruction.
        user_timezone: IANA name, e.g. "Europe/London". Optional; defaults
                       to UTC interpretation if missing.

    Returns:
        {"patch": {...changed fields only...}, "reply": "short string"}.
        If the LLM couldn't figure out a change, patch is {} and reply
        explains what's missing.
    """
    now_utc = datetime.now(timezone.utc)
    context_lines = [
        f"Current date/time: {now_utc.strftime('%Y-%m-%d %H:%M UTC')}",
    ]
    if user_timezone:
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(user_timezone)
            local_now = now_utc.astimezone(tz)
            context_lines.append(
                f"User's timezone: {user_timezone}\n"
                f"User's local time: {local_now.strftime('%Y-%m-%d %H:%M %Z (UTC%z)')}\n"
                f"When the user mentions a time, interpret it as their LOCAL time."
            )
        except Exception:  # noqa: BLE001 — bad tz is non-fatal
            pass

    # Send only the fields the prompt cares about so we don't waste
    # tokens on internal bookkeeping (created_at, owner_id, etc).
    task_snapshot = {
        "title": current_task.get("title"),
        "label": current_task.get("label"),
        "description": current_task.get("description"),
        "due_at": current_task.get("due_at"),
        "importance": current_task.get("importance"),
        "status": current_task.get("status"),
    }
    context_lines.append("Current task:\n" + json.dumps(task_snapshot, indent=2))

    # Without this the reply comes back in English even when the user
    # spoke Portuguese — the prompt itself is English.
    from app.services.locale import get_locale

    context_lines.append(get_locale(language).prompt_instruction)

    system = _SYSTEM_PROMPT + "\n\n" + "\n".join(context_lines)

    raw = await get_ai_response(
        prompt=user_message,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=system,
        intent="daily_chat",
        max_tokens=400,
    )

    try:
        result = json.loads(strip_json_fences(raw))
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Task updater failed to parse: %s | raw=%s", exc, raw[:200])
        return {
            "patch": {},
            "reply": "Couldn't parse that update — say which field you want to change.",
        }

    reply = str(result.get("reply", "")).strip() or "Updated."
    patch = {
        k: v for k, v in result.items()
        if k in _ALLOWED_PATCH_FIELDS
    }

    # Convert any naive due_at the LLM emitted into UTC using the
    # user's timezone. The prompt asks for naive local time; treating
    # a missing tz as UTC would silently shift the user's intent.
    if "due_at" in patch and isinstance(patch["due_at"], str):
        parsed_due = _parse_due_at(patch["due_at"], user_timezone=user_timezone)
        if parsed_due is not None:
            patch["due_at"] = (
                parsed_due.astimezone(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        else:
            # LLM produced something unparseable — drop the field
            # rather than persist garbage.
            del patch["due_at"]

    # Authoritative clock-time override from the transcript. If the
    # user said an explicit time like "20" or "8 PM", that's what we
    # use — regardless of what number the LLM emitted. The LLM still
    # gets to own the date so "move it to Friday at 8 PM" combines
    # its date arithmetic with our regex'd hour.
    if "due_at" in patch and isinstance(patch.get("due_at"), str):
        overridden = override_due_at_clock(
            patch["due_at"],
            user_message,
            user_timezone,
            language=language,
        )
        if overridden is not None:
            patch["due_at"] = overridden

    return {"patch": patch, "reply": reply}
