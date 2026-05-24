"""Helpers to (re)generate the embedding for a task bubble.

Called fire-and-forget from FastAPI BackgroundTasks after a task is
created or updated. We never block the user-facing response on this —
embedding generation takes a network round-trip to OpenAI and the
user shouldn't wait for it just to see their new bubble appear.

A failed embedding (network blip, missing key) is logged and dropped.
The task still exists in the DB with embedding=NULL; the next update
or the backfill script will fill it in. Search just skips tasks
without embeddings.
"""

import logging
from uuid import UUID

from app.db import tasks as tasks_db
from app.services.embeddings import generate_embedding

logger = logging.getLogger(__name__)


def _build_embed_text(title: str | None, label: str | None, description: str | None) -> str:
    """Join the searchable fields into a single string for embedding.

    Title gets the most weight by virtue of usually being present;
    label and description add context when they exist. We deliberately
    skip cluster name / due dates / importance — those are filterable
    via SQL, not semantic match.
    """
    parts: list[str] = []
    if title:
        parts.append(title.strip())
    if label and label.strip() and label.strip().lower() != (title or "").strip().lower():
        parts.append(label.strip())
    if description:
        parts.append(description.strip())
    return " — ".join(p for p in parts if p)


async def regenerate_task_embedding(task_id: UUID, owner_id: UUID) -> None:
    """Generate a fresh embedding for a task and persist it.

    Fetches the task by id+owner, embeds title/label/description, and
    writes the vector back via a partial update. Logs and exits
    silently on any failure.
    """
    try:
        task = await tasks_db.fetch_task_by_id(task_id, owner_id)
        if task is None:
            logger.warning("Task %s not found while embedding", task_id)
            return

        text = _build_embed_text(
            task.get("title"),
            task.get("label"),
            task.get("description"),
        )
        if not text:
            return

        vec = await generate_embedding(text)
        if vec is None:
            return

        await tasks_db.update_task(task_id, owner_id, {"embedding": vec})
    except Exception as exc:  # noqa: BLE001 — background task must never raise
        logger.warning("Background embedding failed for task %s: %s", task_id, exc)
