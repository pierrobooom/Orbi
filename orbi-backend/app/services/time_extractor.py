"""Extract an explicit clock time from a user transcript.

Why this exists: Llama 8B is unreliable at clock arithmetic. Even with
the prompt saying "emit the user's local time, no conversion", it still
adds/subtracts the UTC offset in unpredictable directions. By scanning
the transcript directly we get the literal hour/minute the user said,
and overwrite the LLM's hour-of-day after it produced the date.

We do this server-side so the same logic applies to both the create
flow (chat router → sanitize_parsed_task) and the voice-update flow
(task_updater). The LLM still owns the date because it handles things
like "tomorrow" and "next Friday" reliably; only the time-of-day is
fragile.

Diagnostic logs (WARNING-level so uvicorn surfaces them) trace every
override decision: input transcript, LLM's due_at, extracted clock,
final corrected due_at. Tail the backend log to see exactly what the
server computed when reproducing time bugs.
"""

import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# 12-hour with AM/PM: "8 PM", "8:30 AM", "8.30 pm", "10 am"
_RE_AMPM = re.compile(
    r"\b(\d{1,2})(?:[:.\s]\s*(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b",
    re.IGNORECASE,
)

# 24-hour with explicit minutes: "20:00", "20:30", "20.30", "8:00"
_RE_24H_MIN = re.compile(r"\b(\d{1,2})[:.](\d{2})\b")

# Standalone "X o'clock" or "X hours" in 24-hour context: "at 20",
# "at 20 o'clock", "at 8 oclock", "20h", "20 hours"
_RE_OCLOCK = re.compile(
    r"\b(?:at\s+)?(\d{1,2})\s*(?:o['’]?clock|h(?:ours?)?|hrs?)\b",
    re.IGNORECASE,
)


def extract_local_clock(transcript: str) -> tuple[int, int] | None:
    """Return (hour, minute) for the most prominent clock time in the
    transcript, or None if no explicit time is mentioned.

    Patterns are tried in order of specificity — AM/PM first (most
    unambiguous), then HH:MM, then "X o'clock" / "X hours".
    """
    if not transcript:
        return None

    # --- 12-hour AM/PM ---------------------------------------------
    m = _RE_AMPM.search(transcript)
    if m:
        h = int(m.group(1)) % 12
        minute = int(m.group(2) or 0)
        suffix = m.group(3).lower().replace(".", "")
        if suffix.startswith("p"):
            h += 12
        if 0 <= h < 24 and 0 <= minute < 60:
            return (h, minute)

    # --- HH:MM 24-hour ---------------------------------------------
    m = _RE_24H_MIN.search(transcript)
    if m:
        h = int(m.group(1))
        minute = int(m.group(2))
        if 0 <= h < 24 and 0 <= minute < 60:
            return (h, minute)

    # --- "X o'clock" / "X hours" -----------------------------------
    m = _RE_OCLOCK.search(transcript)
    if m:
        h = int(m.group(1))
        if 0 <= h < 24:
            return (h, 0)

    return None


def override_due_at_clock(
    llm_due_at: str | None,
    transcript: str,
    user_timezone: str | None,
) -> str | None:
    """If the transcript has an explicit clock time, replace the
    hour/minute of the LLM's due_at with it. Keeps the LLM's date.

    Returns the corrected due_at as ISO 8601 UTC ("...Z"), or the
    original value if no override is needed / possible. Always
    returns a UTC string with Z suffix when it returns a string.
    """
    if not llm_due_at:
        logger.warning(
            "time_extractor: no LLM due_at provided. transcript=%r tz=%s",
            transcript[:120],
            user_timezone,
        )
        return llm_due_at

    clock = extract_local_clock(transcript)
    if clock is None:
        logger.warning(
            "time_extractor: no clock in transcript. transcript=%r tz=%s llm=%s",
            transcript[:120],
            user_timezone,
            llm_due_at,
        )
        return llm_due_at  # nothing to override

    # Reuse the sanitizer's tolerant parser to get a tz-aware datetime
    # in the user's local zone (the sanitizer treats wall-clock
    # components as local when user_timezone is provided).
    from app.services.task_sanitizer import _parse_due_at

    parsed = _parse_due_at(llm_due_at, user_timezone=user_timezone)
    if parsed is None:
        return llm_due_at

    hour, minute = clock

    if user_timezone:
        try:
            from zoneinfo import ZoneInfo
            local = parsed.astimezone(ZoneInfo(user_timezone))
            corrected_local = local.replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            result = (
                corrected_local.astimezone(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            logger.warning(
                "time_extractor: OVERRIDE transcript=%r clock=%02d:%02d tz=%s "
                "llm_due_at=%s local=%s corrected_local=%s -> %s",
                transcript[:120],
                hour, minute,
                user_timezone,
                llm_due_at,
                local.isoformat(),
                corrected_local.isoformat(),
                result,
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.warning("time_extractor: tz failure %s — falling back", exc)

    # No timezone — replace in whatever tz `parsed` already has.
    corrected = parsed.replace(hour=hour, minute=minute, second=0, microsecond=0)
    result = (
        corrected.astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    logger.warning(
        "time_extractor: no tz — override transcript=%r clock=%02d:%02d "
        "llm_due_at=%s -> %s",
        transcript[:120],
        hour, minute,
        llm_due_at,
        result,
    )
    return result
