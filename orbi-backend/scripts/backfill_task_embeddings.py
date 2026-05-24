"""One-off script to backfill embeddings for existing tasks.

Run this once after switching the embeddings provider to OpenAI (or
any time the embedding model changes and you want to refresh all
vectors). It loops through tasks with NULL embeddings, generates a
fresh vector for each, and writes it back via the same code path the
live create/update endpoints use.

Usage:
    cd orbi-backend
    python -m scripts.backfill_task_embeddings           # all users, all NULL embeddings
    python -m scripts.backfill_task_embeddings --user UUID  # one user

Pacing: 0.3s between OpenAI calls. At ~1k tasks that's about 5
minutes; OpenAI's per-key rate limit on text-embedding-3-small is
generous so this is conservative.
"""

import argparse
import asyncio
import logging
import sys
from uuid import UUID

# load_dotenv runs in main.py at app startup. For this standalone
# script we need to do it ourselves so SUPABASE_URL / OPENAI_API_KEY
# resolve.
from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from app.db import tasks as tasks_db  # noqa: E402
from app.services.task_embedding import regenerate_task_embedding  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("backfill")

# Conservative pacing so we don't hammer OpenAI's rate limit.
SLEEP_BETWEEN = 0.3
# Largest single fetch from Supabase. We loop until exhausted.
BATCH = 100


async def main(owner_id: UUID | None) -> int:
    total = 0
    while True:
        rows = await tasks_db.fetch_tasks_without_embeddings(
            owner_id=owner_id,
            limit=BATCH,
        )
        if not rows:
            break

        logger.info("Embedding batch of %d tasks…", len(rows))
        for row in rows:
            try:
                task_id = UUID(str(row["id"]))
                row_owner = UUID(str(row["owner_id"]))
                await regenerate_task_embedding(task_id, row_owner)
                total += 1
            except Exception as exc:  # noqa: BLE001 — keep going on individual failures
                logger.warning("Skipping task %s: %s", row.get("id"), exc)
            await asyncio.sleep(SLEEP_BETWEEN)

    logger.info("Backfill complete — %d tasks embedded.", total)
    return total


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill task embeddings.")
    p.add_argument(
        "--user",
        type=str,
        default=None,
        help="Limit to a single owner_id (UUID). Default: all users.",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    owner = UUID(args.user) if args.user else None
    rc = asyncio.run(main(owner))
    sys.exit(0 if rc >= 0 else 1)
