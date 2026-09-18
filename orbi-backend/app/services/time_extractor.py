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
from datetime import datetime, timedelta, timezone

from app.services.privacy import safe_transcript

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

# --------------------------------------------------------------------
# Portuguese (pt-PT)
# --------------------------------------------------------------------
# Portuguese states time in ways none of the English patterns catch:
# "às oito da noite" (word number + part-of-day), "meio-dia", "20h30",
# "às oito e meia". Without these, every pt-PT capture with a spoken
# time silently lost it — the English patterns matched nothing and the
# LLM's own (unreliable) hour survived.

_PT_NUMBER_WORDS = {
    "uma": 1, "duas": 2, "tres": 3, "três": 3, "quatro": 4, "cinco": 5,
    "seis": 6, "sete": 7, "oito": 8, "nove": 9, "dez": 10, "onze": 11,
    "doze": 12,
}

# "20h30", "20h 30", "8h05" — the h-separated form is how Portuguese
# writes times far more often than "20:30".
_RE_PT_HMIN = re.compile(r"\b(\d{1,2})\s*h\s*(\d{2})\b", re.IGNORECASE)

# "às 8", "as 20", "à uma", "as oito" — with an optional part-of-day
# qualifier that decides AM vs PM.
# Portuguese introduces a clock time with several prepositions, not just
# "às": "das 9 da manhã", "pelas 9", "por volta das 9". Accepting only
# "às/as" meant those fell through to the model's own hour, which is the
# thing this module exists to stop trusting.
#
# The alternation deliberately does NOT include a bare unaccented "a".
# It used to, as `[àa]s?`, and that turned every "a" followed by a number
# anywhere in a sentence into a clock time: "daqui a 10 minutos" was read
# as 10 o'clock and a shower scheduled for 22:22 was stored as 10:00.
# "ligar a 3 pessoas" would have become 03:00 the same way. The accented
# "à" is kept because "à uma" is a real way to say one o'clock and the
# accent makes it unambiguous.
_RE_PT_AT = re.compile(
    r"\b(?:[àa]s|à|das|pelas|para\s+as)\s+(\d{1,2}|"
    + "|".join(_PT_NUMBER_WORDS)
    + r")"
    r"(?:\s*[:h]\s*(\d{2}))?"
    r"(\s+e\s+meia)?"
    r"(?:\s+(?:da|de)\s+(manhã|manha|tarde|noite|madrugada))?",
    re.IGNORECASE,
)

_RE_PT_MIDDAY = re.compile(r"\bmeio[-\s]?dia\b", re.IGNORECASE)
_RE_PT_MIDNIGHT = re.compile(r"\bmeia[-\s]?noite\b", re.IGNORECASE)


def _extract_portuguese_clock(transcript: str) -> tuple[int, int] | None:
    """Portuguese clock phrases. Returns (hour, minute) or None."""
    if _RE_PT_MIDDAY.search(transcript):
        return (12, 0)
    if _RE_PT_MIDNIGHT.search(transcript):
        return (0, 0)

    m = _RE_PT_HMIN.search(transcript)
    if m:
        hour, minute = int(m.group(1)), int(m.group(2))
        if 0 <= hour < 24 and 0 <= minute < 60:
            return (hour, minute)

    m = _RE_PT_AT.search(transcript)
    if m:
        raw_hour = m.group(1).lower()
        hour = (
            int(raw_hour)
            if raw_hour.isdigit()
            else _PT_NUMBER_WORDS.get(raw_hour, -1)
        )
        if hour < 0:
            return None
        minute = int(m.group(2) or 0)
        if m.group(3):  # "e meia" — half past
            minute = 30
        part = (m.group(4) or "").lower()
        # Part-of-day disambiguates a 1-12 hour. "às oito da noite" is
        # 20:00; a bare "às 20" is already unambiguous and left alone.
        if part in {"tarde", "noite"} and hour < 12:
            hour += 12
        elif part == "madrugada" and hour == 12:
            hour = 0
        elif part in {"manhã", "manha"} and hour == 12:
            hour = 0
        if 0 <= hour < 24 and 0 <= minute < 60:
            return (hour, minute)

    return None


def extract_local_clock(
    transcript: str,
    language: str | None = None,
) -> tuple[int, int] | None:
    """Return (hour, minute) for the most prominent clock time in the
    transcript, or None if no explicit time is mentioned.

    Patterns are tried in order of specificity — AM/PM first (most
    unambiguous), then HH:MM, then "X o'clock" / "X hours".

    For Portuguese the language-specific patterns run FIRST, because the
    English ones produce wrong answers on Portuguese input rather than
    simply failing: "às 8 da noite" hits the bare HH pattern and yields
    08:00 instead of 20:00. Language defaults to English, so existing
    English callers are unaffected.
    """
    if not transcript:
        return None

    from app.services.locale import is_portuguese

    if is_portuguese(language):
        pt = _extract_portuguese_clock(transcript)
        if pt is not None:
            return pt

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


# --------------------------------------------------------------------
# Relative offsets — "daqui a 10 minutos", "in two hours"
# --------------------------------------------------------------------
# These were handled by nobody. There is no clock time in "daqui a 10
# minutos" to extract, so the whole datetime fell through to the model,
# which is unreliable at exactly this arithmetic — asked at 22:12 for ten
# minutes' time it produced 09:00 the same morning, a deadline eleven
# hours in the past, and the task was silently never reminded about
# because plan_for_task drops triggers that have already been.
#
# Unlike the clock and weekday passes, a relative offset determines the
# DATE AND THE TIME together, so it replaces the model's due_at outright
# rather than patching a component of it.

_EN_SMALL_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40,
    "forty-five": 45, "sixty": 60, "a": 1, "an": 1, "half": 0,
}

_PT_SMALL_NUMBERS = {
    "um": 1, "uma": 1, "dois": 2, "duas": 2, "tres": 3, "três": 3,
    "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8, "nove": 9,
    "dez": 10, "quinze": 15, "vinte": 20, "trinta": 30, "quarenta": 40,
    "sessenta": 60, "meia": 0, "meio": 0,
}

# "daqui a 10 minutos", "dentro de 2 horas", "em 30 minutos",
# "daqui a uma hora", "passado 10 minutos".
# The lead-in is REQUIRED: a bare "10 minutos" in "demora 10 minutos"
# describes how long the task takes, not when it is due.
_RE_PT_RELATIVE = re.compile(
    r"\b(?:daqui\s+a|dentro\s+de|passad[oa]s?|d'?aqui\s+a|em)\s+"
    r"(\d{1,3}|" + "|".join(_PT_SMALL_NUMBERS) + r")?\s*"
    r"(minutos?|min|horas?|dias?|semanas?)\b",
    re.IGNORECASE,
)

# "in 10 minutes", "in two hours", "in half an hour", "in a day".
_RE_EN_RELATIVE = re.compile(
    r"\bin\s+(\d{1,3}|" + "|".join(_EN_SMALL_NUMBERS) + r")?\s*"
    r"(?:an?\s+)?"
    r"(minutes?|mins?|hours?|hrs?|days?|weeks?)\b",
    re.IGNORECASE,
)

_UNIT_TO_MINUTES = {
    "min": 1, "mins": 1, "minute": 1, "minutes": 1,
    "minuto": 1, "minutos": 1,
    "hour": 60, "hours": 60, "hr": 60, "hrs": 60,
    "hora": 60, "horas": 60,
    "day": 1440, "days": 1440, "dia": 1440, "dias": 1440,
    "week": 10080, "weeks": 10080, "semana": 10080, "semanas": 10080,
}


def extract_relative_offset(
    transcript: str, language: str | None = None
) -> timedelta | None:
    """Return how far in the future the user asked for, or None.

    "meia hora" / "half an hour" resolve to 30 minutes rather than zero —
    the word maps to 0 in the number tables because it means "half of the
    following unit", which is only meaningful once the unit is known.
    """
    if not transcript:
        return None

    from app.services.locale import is_portuguese

    portuguese = is_portuguese(language)
    pattern = _RE_PT_RELATIVE if portuguese else _RE_EN_RELATIVE
    words = _PT_SMALL_NUMBERS if portuguese else _EN_SMALL_NUMBERS

    match = pattern.search(transcript)
    if match is None:
        # A Portuguese transcript can still carry an English phrasing and
        # vice versa; trying the other pattern costs one regex and saves
        # the fallback to the model's arithmetic.
        other = _RE_EN_RELATIVE if portuguese else _RE_PT_RELATIVE
        other_words = _EN_SMALL_NUMBERS if portuguese else _PT_SMALL_NUMBERS
        match = other.search(transcript)
        if match is None:
            return None
        words = other_words

    raw_count, raw_unit = match.group(1), match.group(2).lower()
    unit_minutes = _UNIT_TO_MINUTES.get(raw_unit)
    if unit_minutes is None:
        return None

    if raw_count is None:
        # "in an hour", "dentro de horas" — no number said, assume one.
        count = 1.0
    elif raw_count.isdigit():
        count = float(raw_count)
    else:
        mapped = words.get(raw_count.lower())
        if mapped is None:
            return None
        # "meia hora" / "half an hour": half of the unit that follows.
        count = 0.5 if mapped == 0 else float(mapped)

    minutes = count * unit_minutes
    # Guard against a mis-transcribed "in 999 weeks" landing a task two
    # decades out. A year is already past any plausible spoken offset.
    if minutes <= 0 or minutes > 525600:
        return None
    return timedelta(minutes=minutes)


def override_due_at_relative(
    llm_due_at: str | None,
    transcript: str,
    language: str | None = None,
    now: datetime | None = None,
) -> tuple[str | None, bool]:
    """Resolve "in N minutes" against the clock, ignoring the model.

    Returns (due_at, handled). When `handled` is True the caller must skip
    the weekday and clock passes: this offset already fixed both halves of
    the datetime, and letting the clock pass run afterwards would rewrite
    the hour from some unrelated number elsewhere in the sentence.
    """
    offset = extract_relative_offset(transcript, language=language)
    if offset is None:
        return llm_due_at, False

    resolved = (now or datetime.now(timezone.utc)) + offset
    # Seconds are noise on a spoken offset and make the stored value look
    # machine-generated when the user reads it back.
    resolved = resolved.replace(second=0, microsecond=0)
    result = resolved.isoformat().replace("+00:00", "Z")

    logger.warning(
        "time_extractor: RELATIVE transcript=%s offset=%s llm_due_at=%s -> %s",
        safe_transcript(transcript),
        offset,
        llm_due_at,
        result,
    )
    return result, True


def override_due_at_clock(
    llm_due_at: str | None,
    transcript: str,
    user_timezone: str | None,
    language: str | None = None,
) -> str | None:
    """If the transcript has an explicit clock time, replace the
    hour/minute of the LLM's due_at with it. Keeps the LLM's date.

    Returns the corrected due_at as ISO 8601 UTC ("...Z"), or the
    original value if no override is needed / possible. Always
    returns a UTC string with Z suffix when it returns a string.
    """
    if not llm_due_at:
        logger.warning(
            "time_extractor: no LLM due_at provided. transcript=%s tz=%s",
            safe_transcript(transcript),
            user_timezone,
        )
        return llm_due_at

    clock = extract_local_clock(transcript, language=language)
    if clock is None:
        logger.warning(
            "time_extractor: no clock in transcript. transcript=%s tz=%s llm=%s",
            safe_transcript(transcript),
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
                "time_extractor: OVERRIDE transcript=%s clock=%02d:%02d tz=%s "
                "llm_due_at=%s local=%s corrected_local=%s -> %s",
                safe_transcript(transcript),
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
        "time_extractor: no tz — override transcript=%s clock=%02d:%02d "
        "llm_due_at=%s -> %s",
        safe_transcript(transcript),
        hour, minute,
        llm_due_at,
        result,
    )
    return result


# --------------------------------------------------------------------
# Weekday resolution
# --------------------------------------------------------------------
# The model is unreliable at calendar arithmetic in exactly the way it is
# unreliable at clock arithmetic. Asked for "Friday morning" on Saturday
# 2026-08-29 it returned 2026-08-30, a Sunday. The sanitiser only rejects
# implausible dates (past, or >5 years out), so a wrong weekday sails
# straight through and the user gets a reminder on the wrong day.
#
# Same division of labour as the clock override: a regex owns what the
# user literally said, the model owns everything vaguer.

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
    # pt-PT. "Sábado"/"domingo" are the only ones that aren't
    # "<n>-feira"; the numbered ones are often said without the suffix,
    # so both spellings are accepted.
    # Three spellings each, because all three occur in real transcripts:
    # hyphenated as written, bare as spoken, and RUN TOGETHER because
    # Deepgram returns "segundafeira" for spoken "segunda-feira". Missing
    # that last form is not cosmetic — it silently disabled the weekday
    # correction on the exact phrasing a Portuguese speaker uses most.
    "segunda-feira": 0, "segundafeira": 0, "segunda": 0,
    "terça-feira": 1, "terçafeira": 1, "terça": 1,
    "terca-feira": 1, "tercafeira": 1, "terca": 1,
    "quarta-feira": 2, "quartafeira": 2, "quarta": 2,
    "quinta-feira": 3, "quintafeira": 3, "quinta": 3,
    "sexta-feira": 4, "sextafeira": 4, "sexta": 4,
    "sábado": 5, "sabado": 5,
    "domingo": 6,
}

# "next Friday" / "na próxima sexta" means the week AFTER the coming one
# for most speakers when today is early in the week. This is genuinely
# ambiguous in both languages, so the rule is: plain "Friday" is the next
# occurrence (today counts only if it hasn't passed), and an explicit
# "next"/"próxima" adds a week ONLY when the plain answer is within the
# current week.
_NEXT_MARKERS = ("next ", "próxima ", "proxima ", "próximo ", "proximo ")

_WEEKDAY_RE = re.compile(
    r"\b(next\s+|pr[óo]xim[ao]\s+)?("
    + "|".join(sorted(_WEEKDAYS, key=len, reverse=True))
    + r")\b",
    re.IGNORECASE,
)


def extract_weekday(transcript: str) -> tuple[int, bool] | None:
    """Return (weekday_index, is_explicit_next) or None.

    weekday_index follows date.weekday(): Monday is 0.
    """
    if not transcript:
        return None
    match = _WEEKDAY_RE.search(transcript)
    if not match:
        return None
    marker, name = match.group(1), match.group(2).lower()
    index = _WEEKDAYS.get(name)
    if index is None:
        return None
    return index, bool(marker)


def resolve_weekday_date(
    reference: "datetime",
    weekday_index: int,
    *,
    explicit_next: bool = False,
) -> "datetime":
    """Return the next date falling on weekday_index, at reference's time.

    `reference` should already be in the user's local timezone — "Friday"
    means Friday where they are, not in UTC.
    """
    delta = (weekday_index - reference.weekday()) % 7
    if delta == 0:
        # Today already is that weekday. A bare mention means today (the
        # clock override decides the hour); an explicit "next"/"próxima"
        # means the following week, which is the one case where the
        # marker genuinely changes the answer.
        delta = 7 if explicit_next else 0
    # NOTE: an explicit marker does NOT add a week otherwise. "Next
    # Monday" and "na próxima segunda-feira" said on a Saturday both mean
    # the Monday two days away, not the one nine days away. Adding a week
    # there was a real bug: a task spoken for the coming Monday landed a
    # week and a half out.
    return reference + timedelta(days=delta)


def override_due_at_weekday(
    llm_due_at: str | None,
    transcript: str,
    user_timezone: str | None,
) -> str | None:
    """Correct the DATE of an LLM due_at when the user named a weekday.

    Keeps the LLM's time-of-day (the clock override runs separately and
    owns that). Returns the original value when no weekday was named, or
    when the LLM's date already lands on the right day — the common case,
    which must stay untouched.
    """
    if not llm_due_at:
        return llm_due_at
    found = extract_weekday(transcript)
    if found is None:
        return llm_due_at
    weekday_index, explicit_next = found

    from app.services.task_sanitizer import _parse_due_at

    parsed = _parse_due_at(llm_due_at, user_timezone=user_timezone)
    if parsed is None:
        return llm_due_at

    local = parsed
    if user_timezone:
        try:
            from zoneinfo import ZoneInfo

            local = parsed.astimezone(ZoneInfo(user_timezone))
        except Exception:  # noqa: BLE001 — bad tz is not worth failing on
            local = parsed

    if local.weekday() == weekday_index:
        return llm_due_at  # model got it right

    now_local = datetime.now(local.tzinfo) if local.tzinfo else datetime.utcnow()
    corrected = resolve_weekday_date(
        now_local.replace(
            hour=local.hour, minute=local.minute, second=0, microsecond=0
        ),
        weekday_index,
        explicit_next=explicit_next,
    )
    logger.warning(
        "time_extractor: WEEKDAY OVERRIDE transcript=%s llm=%s (%s) -> %s (%s)",
        safe_transcript(transcript),
        llm_due_at,
        local.strftime("%A"),
        corrected.isoformat(),
        corrected.strftime("%A"),
    )
    return corrected.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
