"""Defensive cleanup for task-parser output.

The Spark tier runs Llama 3.1 8B-Instant which is fast and cheap but
unreliable at structured extraction. Common failure modes:

  - Title left verbose ("Remind me to call mum tomorrow" instead of
    "Call mum"). The prompt asks for imperative form but 8B obeys
    inconsistently.
  - Year hallucinated to 2024 because the model's training data is
    heavily skewed there, so it ignores "Current date: 2026-...".
  - Times shifted by a few hours from what the user said.
  - Importance left at the default even when urgency cues are present.

We could chase each of these in prompt tuning (and we do), but a
deterministic post-processing layer means the user never sees the
worst cases regardless of model output. Better to drop a bad due_at
than to schedule a reminder for two years ago.

Sanitization is shared between the merged-coordinator embedded data
path and the standalone task_parser.parse_task() fallback so both
behave identically.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

# Phrases the user often says before the actual task. The parser
# should rewrite these out of the title; in practice it often doesn't.
# Stripped in order, case-insensitive, only at the start. Longer
# variants first so "i need to" wins over "need to".
_VERBOSE_TITLE_PREFIXES = (
    # "I ..." variants
    "can you please remind me to",
    "can you remind me to",
    "please remind me to",
    "remind me to",
    "remind me",
    "i need to",
    "i have to",
    "i should",
    "i want to",
    "i'd like to",
    "i'm going to",
    "im going to",
    "i'm gonna",
    "im gonna",
    "i gotta",
    "i've got to",
    "ive got to",
    # Bare verbs without "I" — Llama 8B sometimes drops the subject
    # and still produces "Need to ..." / "Have to ..." titles.
    "need to",
    "have to",
    "should",
    "want to",
    "going to",
    "gonna",
    "got to",
    "gotta",
    "must",
    "have got to",
    # Imperative-with-preamble
    "make sure to",
    "make sure i",
    "don't forget to",
    "dont forget to",
)

_TITLE_MAX_LEN = 80
_LABEL_MAX_LEN = 28
_DESCRIPTION_MAX_LEN = 240

# Words to drop when deriving a short label from a verbose title. Mirrors
# the JS shortLabel in components/universe/BubbleCanvas.tsx so the
# server-derived label looks like what the client would have computed.
_LABEL_STOP_WORDS = frozenset({
    "a", "an", "the", "to", "from", "about", "of", "for", "with",
    "and", "or", "in", "on", "at", "by", "as", "is", "was", "are",
    "be", "been", "this", "that", "these", "those", "my", "your",
    "i", "im", "i'm", "ive", "i've",
})
_LABEL_LOW_SIGNAL_VERBS = frozenset({
    "call", "buy", "go", "send", "email", "remind", "make", "do",
    "get", "have", "take", "pick", "drop", "visit", "see", "check",
    "need", "want", "should", "must", "gotta", "going", "gonna",
})

# A bad due_at is worse than no due_at — silent wrong reminders
# corrode trust. Anything outside this window gets nulled out and the
# user can edit the task to add the real time.
_DUE_PAST_TOLERANCE = timedelta(hours=1)  # accept times up to 1h in the past
_DUE_FUTURE_HORIZON = timedelta(days=365 * 5)  # five years out


def _strip_verbose_prefix(title: str, language: str | None = None) -> str:
    """Drop common "remind me to ..." / "I need to ..." preambles.

    The prefix list comes from the user's locale. Without this a
    Portuguese capture kept its lead-in and produced a task titled
    "Preciso de ligar à minha mãe" instead of "Ligar à minha mãe".
    """
    from app.services.locale import get_locale

    prefixes = get_locale(language).title_prefixes or _VERBOSE_TITLE_PREFIXES
    s = title.strip()
    lower = s.lower()
    for prefix in prefixes:
        if lower.startswith(prefix + " ") or lower == prefix:
            s = s[len(prefix):].strip()
            lower = s.lower()
            # Loop once more in case prefixes stack ("I need to remind me to...")
    # Capitalize the first letter — these models often produce lowercase
    # after the strip and it looks unfinished.
    if s:
        s = s[0].upper() + s[1:]
    return s


def _parse_due_at(value: Any, user_timezone: str | None = None) -> datetime | None:
    """Return a tz-aware datetime if value parses as ISO 8601, else None.

    Llama 8B can't reliably follow "no timezone marker" instructions —
    it attaches `Z` or `+00:00` to outputs roughly half the time even
    when the prompt is explicit. So:

      - If we know the user's timezone, we ALWAYS treat the LLM's
        wall-clock components as the user's local time. Any zone
        marker the LLM happened to add is discarded.
      - If we don't know the user's timezone, fall back to: explicit
        markers trusted, naive treated as UTC.

    This is the only contract that's robust against the model emitting
    "2026-05-29T19:00:00Z" when it should have said "2026-05-29T19:00:00".
    """
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    # Some models emit "Z"-suffixed timestamps that fromisoformat couldn't
    # handle until Python 3.11+. We're on 3.12 but normalising is cheap.
    raw = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None

    if user_timezone:
        try:
            from zoneinfo import ZoneInfo
            # Strip whatever timezone the LLM tacked on (often a wrong Z)
            # and re-attach the user's actual zone. The wall-clock
            # hour/minute is what the user said — that's the truth.
            naive = dt.replace(tzinfo=None)
            return naive.replace(tzinfo=ZoneInfo(user_timezone))
        except Exception:  # noqa: BLE001 — bad tz string is non-fatal
            pass

    # No user_timezone or zoneinfo failed: trust explicit markers,
    # otherwise default naive datetimes to UTC.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def derive_label_from_title(title: str, max_chars: int = 14) -> str:
    """Best-effort short label from a task title — server-side mirror of
    the JS shortLabel. Used when the LLM didn't produce a label or when
    the client didn't include one in a typed-create body.
    """
    import re

    trimmed = (title or "").strip()
    if not trimmed:
        return ""
    if len(trimmed) <= max_chars:
        return trimmed

    words = re.split(r"\s+", trimmed)

    def is_content(word: str) -> bool:
        lower = re.sub(r"[^a-z0-9']", "", word.lower())
        if not lower:
            return False
        if lower in _LABEL_STOP_WORDS:
            return False
        if lower in _LABEL_LOW_SIGNAL_VERBS:
            return False
        return True

    content = [w for w in words if is_content(w)]
    pick_from = content if content else words
    out = ""
    for word in pick_from:
        candidate = f"{out} {word}".strip() if out else word
        if len(candidate) > max_chars:
            break
        out = candidate
    if not out:
        out = trimmed[:max_chars]
    return out


def sanitize_parsed_task(
    data: dict,
    now: datetime | None = None,
    user_timezone: str | None = None,
    language: str | None = None,
) -> dict:
    """Return a cleaned-up copy of the LLM's parsed task dict.

    Never mutates the input. Always returns a dict shaped like the
    inputs the create-task endpoint expects. When user_timezone is
    provided, naive due_at values are interpreted as the user's local
    wall-clock time and converted to UTC — keeping the LLM out of
    timezone arithmetic, which it does poorly.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    cleaned = dict(data)  # shallow copy

    # --- title -------------------------------------------------------
    raw_title = cleaned.get("title")
    if isinstance(raw_title, str):
        title = _strip_verbose_prefix(raw_title, language=language)
        if len(title) > _TITLE_MAX_LEN:
            title = title[:_TITLE_MAX_LEN].rstrip()
        cleaned["title"] = title
    else:
        cleaned["title"] = ""

    # --- label -------------------------------------------------------
    # Prefer the LLM's label when it provided one; otherwise derive
    # from the (already cleaned) title. Either way, trim to the cap so
    # the bubble layer never has to truncate again.
    raw_label = cleaned.get("label")
    if isinstance(raw_label, str) and raw_label.strip():
        label = raw_label.strip()
    else:
        label = derive_label_from_title(cleaned["title"])
    if len(label) > _LABEL_MAX_LEN:
        label = label[:_LABEL_MAX_LEN].rstrip()
    cleaned["label"] = label or None

    # --- description -------------------------------------------------
    raw_description = cleaned.get("description")
    if isinstance(raw_description, str) and raw_description.strip():
        description = raw_description.strip()
        if len(description) > _DESCRIPTION_MAX_LEN:
            description = description[:_DESCRIPTION_MAX_LEN].rstrip()
        cleaned["description"] = description
    else:
        cleaned["description"] = None

    # --- due_at ------------------------------------------------------
    due = _parse_due_at(cleaned.get("due_at"), user_timezone=user_timezone)
    if due is None:
        cleaned["due_at"] = None
    else:
        # Always store UTC server-side regardless of the user's zone.
        due_utc = due.astimezone(timezone.utc)
        earliest = now - _DUE_PAST_TOLERANCE
        latest = now + _DUE_FUTURE_HORIZON
        if due_utc < earliest or due_utc > latest:
            logger.info(
                "Sanitizer: dropping implausible due_at %s (now=%s)",
                due_utc.isoformat(), now.isoformat(),
            )
            cleaned["due_at"] = None
        else:
            cleaned["due_at"] = due_utc.isoformat().replace("+00:00", "Z")

    # --- importance --------------------------------------------------
    imp = cleaned.get("importance", 5)
    try:
        imp_int = int(imp)
    except (TypeError, ValueError):
        imp_int = 5
    cleaned["importance"] = max(1, min(10, imp_int))

    # --- confidence --------------------------------------------------
    conf = cleaned.get("confidence", 0.5)
    try:
        conf_f = float(conf)
    except (TypeError, ValueError):
        conf_f = 0.5
    cleaned["confidence"] = max(0.0, min(1.0, conf_f))

    return cleaned


# ---------------------------------------------------------------------
# Cluster matching
# ---------------------------------------------------------------------

def match_cluster_id(
    domain_hint: str | None,
    clusters: list[dict],
) -> str | None:
    """Return the cluster id whose name matches the LLM's domain_hint.

    Substring match on lowercase. Returns None when there's no signal
    (empty hint) or no match (user has no cluster with that domain yet).
    The mobile layout function synthesises a Drift cluster client-side
    when parent_cluster_id is null.
    """
    if not domain_hint or not isinstance(domain_hint, str):
        return None
    hint = domain_hint.lower().strip()
    if not hint:
        return None
    for cluster in clusters:
        name = (cluster.get("name") or "").lower()
        if not name:
            continue
        if hint in name or name in hint:
            return cluster.get("id")
    return None
