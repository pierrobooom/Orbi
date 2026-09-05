"""Assemble what the model needs to know about the user's actual universe.

Until now the coordinator saw four things: the date, the timezone, the
last few messages, and which language to answer in. No tasks, no
clusters. That made it an intent router — it could name a query
("action=list, filter=overdue") for the server to run, but it could not
answer one. "How many tasks do I have?", "what should I do first?" and
"do I already have something about the car?" were all unanswerable, and
the last one is why "Give me leg day task" once tried to create a second
task called Leg day.

What goes in, and why each part
-------------------------------
Retrieval alone is not enough here. A pure semantic search over the
message text answers "tell me about the car" well and "what should I
focus on?" terribly, because the second question doesn't describe the
tasks it's about. So the context is three complementary slices:

  1. OVERDUE      — deterministic. Always relevant to "what now?", and
                    never retrieved by similarity against a vague query.
  2. DUE SOON     — the next 7 days, same reasoning.
  3. RELEVANT     — semantic hits for whatever the user actually said.
                    This is the part that answers "the car one".

Plus a compact cluster list, which is small and tells the model how the
user organises their life — without it, it cannot reason about "work
stuff" as a group.

Sections are deduplicated in that order, so an overdue task never also
appears under "relevant" and burn tokens twice.

Everything is field-stripped and budgeted: a raw task row is ~19 columns
including a 1024-dimension embedding that serialises to ~12KB.
"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from app.services.context_budget import render_records
from app.services.task_resolver import search_tasks_semantic

logger = logging.getLogger(__name__)

# What the model needs to reason about a task. Deliberately excludes
# embedding, owner_id, timestamps and scores it cannot interpret.
_TASK_FIELDS = ("id", "title", "due_at", "importance", "cluster")
_CLUSTER_FIELDS = ("name", "kind")

# Per-section token budgets. The whole block lands around 600-700 tokens,
# which against a ~2,700-token system prompt is a fair price for the
# difference between answering a question and merely routing it.
_OVERDUE_BUDGET = 320
_SOON_BUDGET = 320
_RELEVANT_BUDGET = 420
_CLUSTER_BUDGET = 160

_MAX_PER_SECTION = 12
_SOON_DAYS = 7


def _parse_dt(value) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _shape(task: dict, cluster_names: dict[str, str]) -> dict:
    """Flatten a task row into what the prompt should see."""
    cluster_id = task.get("parent_cluster_id")
    return {
        "id": str(task.get("id")),
        "title": task.get("title"),
        "due_at": task.get("due_at"),
        "importance": task.get("importance"),
        # A name is worth far more to the model than a UUID it cannot
        # resolve, and costs about the same.
        "cluster": cluster_names.get(str(cluster_id), "Adrift") if cluster_id else "Adrift",
    }


async def build_chat_context(
    *,
    message: str,
    user_id: UUID,
    active_tasks: list[dict],
    clusters: list[dict],
) -> str:
    """Return a prompt block describing the user's current universe.

    Empty string when there is nothing to say, so the caller can append
    unconditionally without producing a dangling header.
    """
    if not active_tasks and not clusters:
        return ""

    now = datetime.now(timezone.utc)
    soon_cutoff = now + timedelta(days=_SOON_DAYS)
    cluster_names = {str(c["id"]): str(c.get("name") or "") for c in clusters}

    overdue: list[dict] = []
    soon: list[dict] = []
    for task in active_tasks:
        due = _parse_dt(task.get("due_at"))
        if due is None:
            continue
        if due < now:
            overdue.append(task)
        elif due <= soon_cutoff:
            soon.append(task)

    overdue.sort(key=lambda t: str(t.get("due_at")))
    soon.sort(key=lambda t: str(t.get("due_at")))

    used_ids = {str(t["id"]) for t in overdue} | {str(t["id"]) for t in soon}

    relevant: list[dict] = []
    try:
        hits = await search_tasks_semantic(
            target=message, user_id=user_id, active_tasks=active_tasks, limit=15
        )
        relevant = [t for t in hits if str(t["id"]) not in used_ids]
    except Exception as exc:  # noqa: BLE001 — context is an enhancement
        logger.warning("Chat context retrieval failed: %s", exc)

    sections: list[str] = []

    if overdue:
        sections.append(
            f"OVERDUE ({len(overdue)}):\n"
            + render_records(
                [_shape(t, cluster_names) for t in overdue],
                _TASK_FIELDS,
                max_tokens=_OVERDUE_BUDGET,
                max_records=_MAX_PER_SECTION,
                label="overdue tasks",
            )
        )
    if soon:
        sections.append(
            f"DUE IN THE NEXT {_SOON_DAYS} DAYS ({len(soon)}):\n"
            + render_records(
                [_shape(t, cluster_names) for t in soon],
                _TASK_FIELDS,
                max_tokens=_SOON_BUDGET,
                max_records=_MAX_PER_SECTION,
                label="tasks",
            )
        )
    if relevant:
        sections.append(
            "RELATED TO WHAT THEY JUST SAID:\n"
            + render_records(
                [_shape(t, cluster_names) for t in relevant],
                _TASK_FIELDS,
                max_tokens=_RELEVANT_BUDGET,
                max_records=_MAX_PER_SECTION,
                label="tasks",
            )
        )
    if clusters:
        sections.append(
            f"THEIR CLUSTERS ({len(clusters)}):\n"
            + render_records(
                clusters,
                _CLUSTER_FIELDS,
                max_tokens=_CLUSTER_BUDGET,
                label="clusters",
            )
        )

    if not sections:
        # No dates and no semantic hits, but a total is still an answer to
        # "how many tasks do I have?" — the cheapest useful fact there is.
        sections.append(f"They have {len(active_tasks)} active task(s).")

    body = "\n\n".join(sections)

    return (
        "THE USER'S CURRENT TASKS\n"
        f"They have {len(active_tasks)} active task(s) in total. The lists "
        "below are a partial view selected for this message, not everything.\n\n"
        f"{body}\n\n"
        "Use this to answer questions directly. If the user asks something "
        "you can answer from the data above — how many, what's due, what "
        "they already have about a topic, what to prioritise — answer it in "
        "`response_to_user` with intent `general_chat`, and do NOT route to "
        "an agent. Never invent a task that is not listed above, and say so "
        "plainly when the answer isn't in this data. If they ask you to "
        "CREATE, COMPLETE, DELETE or LIST, ignore this and route normally."
    )
