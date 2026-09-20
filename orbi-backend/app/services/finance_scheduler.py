"""The daily finance jobs: materialise recurring entries, sync bank accounts.

One loop, woken hourly, doing two things that both need to happen roughly once
a day and must survive a restart.

WHY HOURLY AND NOT DAILY
A once-a-day timer has to pick a moment, and whichever moment it picks is the
wrong one for somebody: a user in a different zone, a server that was down at
09:00, a deploy that lands at exactly the wrong minute. Waking hourly and
letting each item's own cooldown decide whether it is due means the schedule
lives in the data and the loop is stateless. The cost is a query an hour that
usually returns nothing.

Bank syncing still honours one call per account per day — that budget is held
by bank_connections.next_sync_after, not by how often this loop runs.
"""

import asyncio
import logging
import os
from datetime import date, datetime, timezone

from app.db import finance as finance_db, finance_accounts as accounts_db
from app.services import recurring
from app.services.bank_sync import sync_due_accounts
from app.services.budget_alerts import run_budget_alerts

logger = logging.getLogger(__name__)

# Hourly. See the module docstring for why this is not daily.
TICK_SECONDS = 3600

# Runs this loop in-process. Same reasoning as the reminder dispatcher: right
# for one instance, wrong for several, where every replica would sync every
# account and multiply the provider bill by the replica count.
RUN_IN_PROCESS = os.environ.get("RUN_FINANCE_SCHEDULER", "1") != "0"


async def materialise_recurring(today: date | None = None) -> dict:
    """Create the finance entries that recurring rules say are owed.

    Idempotent through the deterministic external_id on each occurrence, so a
    double run — two workers, a retry, a manual trigger — writes each entry
    once and the unique index absorbs the rest.
    """
    today = today or datetime.now(timezone.utc).date()
    rules = await accounts_db.fetch_due_recurring(today)
    if not rules:
        return {"rules": 0, "entries": 0}

    written = 0
    for rule in rules:
        try:
            occurrences, next_run = recurring.occurrences_due(rule, today)
            if occurrences:
                rows = [recurring.build_entry(rule, o) for o in occurrences]
                written += await finance_db.insert_entries(rows)

            # Advance the schedule even when nothing was written — a rule that
            # produced only duplicates has still moved on, and leaving
            # next_run_on in the past would re-examine it every hour forever.
            patch: dict = {}
            if next_run is None:
                patch = {"active": False}
            else:
                patch = {"next_run_on": next_run.isoformat()}
            if occurrences:
                patch["last_run_on"] = occurrences[-1].on.isoformat()

            await accounts_db.update_recurring(
                rule["id"], rule["owner_id"], patch
            )
        except Exception as exc:  # noqa: BLE001 — one rule must not stop the rest
            logger.error("Recurring rule %s failed: %s", rule.get("id"), exc)

    if written:
        logger.info("Materialised %s recurring entries from %s rules", written, len(rules))
    return {"rules": len(rules), "entries": written}


async def run_once(now: datetime | None = None) -> dict:
    """One pass of every finance job. Driven by the loop, an endpoint or a test."""
    now = now or datetime.now(timezone.utc)
    recurring_result = await materialise_recurring(now.date())
    sync_result = await sync_due_accounts(now)

    # Runs after the sync so a limit is judged against transactions that
    # arrived moments ago, not against yesterday's picture.
    try:
        budget_result = await run_budget_alerts(now)
    except Exception as exc:  # noqa: BLE001 — alerts must not break the tick
        logger.error("Budget alerts failed: %s", exc)
        budget_result = {"checked": 0, "notified": 0}

    return {
        "recurring": recurring_result,
        "bank_sync": sync_result,
        "budgets": budget_result,
    }


async def run_forever() -> None:
    """Background loop. Started from main.py's lifespan, cancelled on shutdown."""
    logger.info("Finance scheduler started (every %ss)", TICK_SECONDS)
    while True:
        try:
            await asyncio.sleep(TICK_SECONDS)
            result = await run_once()
            if (
                result["recurring"]["entries"]
                or result["bank_sync"]["imported"]
                or result["budgets"]["notified"]
            ):
                logger.info("Finance tick: %s", result)
        except asyncio.CancelledError:
            logger.info("Finance scheduler stopping")
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must outlive any tick
            logger.error("Finance tick failed: %s", exc)
