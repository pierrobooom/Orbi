"""'What do I have today?' — answered by the calendar, not by a model.

WHY THIS BYPASSES THE AI
Asked "what tasks do I have today", the coordinator answered "for the next
7 days you have…", because its context carries a due-in-the-next-7-days
slice and it summarised that instead of asking for the today filter. Asked
again, it did pick the filter — and the filter then counted a task due
tomorrow as today. Two failures, neither of them about language
understanding: "today" is a date range, and a date range is arithmetic.
Project rule: never call an AI for logic that can be computed locally.

So a short question about a named day is recognised here and answered by
the filter directly. It is also one fewer AI call per question.

WHAT "TODAY" MEANS
The user's calendar day, in their timezone — not UTC. Lisbon is UTC+1 in
summer, so near midnight a UTC date comparison moves tasks across the line;
that is exactly how "today" returned a task due tomorrow.

And "today" includes anything already late, because that is also something
today asks of you. This matches the universe header's "N need you today",
so the chat and the screen never disagree about the same word.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "Europe/Lisbon"

# A question about a day only counts if it is also about tasks. "Today was
# long" is not a request for a list.
_TASK_CUES = (
    "tarefa", "tarefas", "task", "tasks", "fazer", "to do", "todo",
    "tenho", "have", "agenda", "plano", "plan", "due", "prazo",
    "o que", "what", "que ha", "whats",
)

_DAYS = {
    "today": ("hoje", "today", "hj", "tonight", "esta noite"),
    "tomorrow": ("amanha", "tomorrow"),
}

# Past this, the message is probably doing something else as well ("add a
# task for tomorrow to…") and belongs with the model, which can parse it.
_MAX_WORDS = 14


def _plain(text: str) -> str:
    """Lower case, accents removed, punctuation spaced out."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^\w\s]", " ", stripped)


def detect(message: str) -> str | None:
    """'today', 'tomorrow', or None if this is not a question about a day's tasks.

    Deliberately narrow. A creation ("amanhã tenho de levar o carro à
    oficina") also names a day and a verb, so anything that reads as a
    statement rather than a question is left to the model. A false negative
    costs one normal AI round trip; a false positive answers a list to
    someone who was trying to add a task.
    """
    text = _plain(message)
    words = text.split()
    if not words or len(words) > _MAX_WORDS:
        return None

    is_question = "?" in message or words[0] in {
        "o", "que", "quais", "qual", "what", "whats", "which", "do", "tenho",
        "any", "algo", "mostra", "show", "lista", "list",
    }
    if not is_question:
        return None

    padded = f" {text} "
    if not any(f" {cue} " in padded or cue in text for cue in _TASK_CUES):
        return None

    found = [
        scope
        for scope, names in _DAYS.items()
        if any(f" {name} " in padded for name in names)
    ]
    # Both days named ("today or tomorrow?") is a range, not a day — leave
    # it to the model rather than silently answering half of it.
    return found[0] if len(found) == 1 else None


def _zone(tz_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def window(scope: str, tz_name: str | None, now: datetime) -> tuple[datetime | None, datetime]:
    """[start, end) in UTC for a scope. start None means "anything before end".

    today    -> everything due before local midnight tonight, late ones included
    tomorrow -> local midnight tonight until local midnight tomorrow night
    """
    zone = _zone(tz_name)
    local_now = now.astimezone(zone)
    today_start = datetime.combine(local_now.date(), time.min, tzinfo=zone)
    tomorrow_start = today_start + timedelta(days=1)
    day_after = tomorrow_start + timedelta(days=1)
    if scope == "today":
        return None, tomorrow_start.astimezone(timezone.utc)
    if scope == "tomorrow":
        return tomorrow_start.astimezone(timezone.utc), day_after.astimezone(timezone.utc)
    raise ValueError(f"unknown scope {scope!r}")


def in_scope(due_at: str | None, scope: str, tz_name: str | None, now: datetime) -> bool:
    """Whether a task due at `due_at` belongs to the scope. Undated never does."""
    if not due_at:
        return False
    try:
        due = datetime.fromisoformat(str(due_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    start, end = window(scope, tz_name, now)
    return (start is None or due >= start) and due < end
