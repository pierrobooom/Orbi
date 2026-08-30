"""Work out which existing task the user just referred to by voice.

Voice commands on existing tasks ("mark the gym one done", "delete the
website task", "push the dentist to Friday") all need the same step
first: turn a spoken description into one specific task id.

Two signals, combined:

  1. Lexical — does the spoken phrase appear in the title or label? This
     catches the common case exactly and costs nothing. It is checked
     first because a user who says a distinctive word ("Mercedes") means
     the task with that word in it, and no embedding should be allowed
     to out-vote that.
  2. Semantic — pgvector similarity against the task embeddings that
     already exist for search (migration 0006). This is what makes "the
     car one" find "Book MOT for the Golf".

The result deliberately carries the runner-up. A voice command that
mutates or deletes must not act on a coin-flip: when the top two
candidates are close, the client asks which one rather than guessing.
"""

import logging
from uuid import UUID

from app.db import tasks as tasks_db
from app.services.embeddings import generate_embedding

logger = logging.getLogger(__name__)

# Below this similarity there is no credible match and the caller should
# say "I couldn't find that task" rather than act on the best of a bad
# set. Higher than the search endpoint's 0.3 because acting on a task is
# far less forgiving than listing it.
_MIN_SIMILARITY = 0.42

# When the top two semantic candidates are within this margin, the match
# is treated as ambiguous — "the car task" with two car tasks should ask,
# not pick.
_AMBIGUITY_MARGIN = 0.05


def _normalise(text: str | None) -> str:
    return " ".join((text or "").lower().split())


def _lexical_matches(target: str, tasks: list[dict]) -> list[dict]:
    """Tasks whose title or label contains the spoken phrase, or vice versa."""
    needle = _normalise(target)
    if len(needle) < 3:
        return []
    hits: list[dict] = []
    for task in tasks:
        title = _normalise(task.get("title"))
        label = _normalise(task.get("label"))
        if not title and not label:
            continue
        if needle in title or (label and needle in label):
            hits.append(task)
            continue
        # The other direction: user said "gym" and the title is "Gym".
        if title and title in needle:
            hits.append(task)
    return hits


async def resolve_task(
    *,
    target: str,
    user_id: UUID,
    active_tasks: list[dict],
) -> dict:
    """Return {task, alternatives, ambiguous, reason}.

    `task` is None when nothing matched well enough. `ambiguous` is True
    when more than one candidate is plausible — the caller should ask
    rather than act. Never raises: a resolution failure degrades to "not
    found", which is a safe answer for a delete command.
    """
    empty = {"task": None, "alternatives": [], "ambiguous": False, "reason": "no_match"}
    if not target or not active_tasks:
        return empty

    # --- lexical first ---------------------------------------------------
    lexical = _lexical_matches(target, active_tasks)
    if len(lexical) == 1:
        return {"task": lexical[0], "alternatives": [], "ambiguous": False, "reason": "lexical"}
    if len(lexical) > 1:
        return {
            "task": lexical[0],
            "alternatives": lexical[1:4],
            "ambiguous": True,
            "reason": "lexical_multi",
        }

    # --- semantic --------------------------------------------------------
    try:
        vector = await generate_embedding(target)
    except Exception as exc:  # noqa: BLE001 — resolution must not throw
        logger.warning("Task resolve embedding failed: %s", exc)
        vector = None
    if vector is None:
        return empty

    try:
        hits = await tasks_db.search_tasks_by_embedding(
            owner_id=user_id,
            query_embedding=vector,
            match_count=5,
            match_threshold=_MIN_SIMILARITY,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Task resolve search failed: %s", exc)
        return empty

    if not hits:
        return empty

    by_id = {str(t["id"]): t for t in active_tasks}
    ranked = [
        (by_id[str(h["id"])], float(h.get("similarity") or 0.0))
        for h in hits
        if str(h["id"]) in by_id
    ]
    if not ranked:
        return empty

    top_task, top_score = ranked[0]
    ambiguous = (
        len(ranked) > 1 and (top_score - ranked[1][1]) < _AMBIGUITY_MARGIN
    )
    logger.info(
        "Task resolve: %r -> %r (%.3f)%s",
        target, top_task.get("title"), top_score, " AMBIGUOUS" if ambiguous else "",
    )
    return {
        "task": top_task,
        "alternatives": [t for t, _ in ranked[1:4]],
        "ambiguous": ambiguous,
        "reason": "semantic",
    }

# Listing is more forgiving than acting: showing a loosely-related task
# costs the user a glance, whereas completing one destroys work. Hence a
# lower bar than _MIN_SIMILARITY.
_LIST_MIN_SIMILARITY = 0.28


async def search_tasks_semantic(
    *,
    target: str,
    user_id: UUID,
    active_tasks: list[dict],
    limit: int = 25,
) -> list[dict]:
    """Tasks semantically related to a spoken phrase, best first.

    Used by the "show me everything about X" voice command, where a
    substring scan over titles is the wrong tool — "everything related to
    the car" should surface "Book MOT" and "Buy new tyres" even though
    neither contains the word "car".

    Returns [] on any failure, which the caller reports as "nothing
    matches" — the same outcome as a genuine empty result.
    """
    if not target or not active_tasks:
        return []
    try:
        vector = await generate_embedding(target)
    except Exception as exc:  # noqa: BLE001
        logger.warning("List search embedding failed: %s", exc)
        return []
    if vector is None:
        return []
    try:
        hits = await tasks_db.search_tasks_by_embedding(
            owner_id=user_id,
            query_embedding=vector,
            match_count=limit,
            match_threshold=_LIST_MIN_SIMILARITY,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("List search failed: %s", exc)
        return []
    by_id = {str(t["id"]): t for t in active_tasks}
    return [by_id[str(h["id"])] for h in hits if str(h["id"]) in by_id]
