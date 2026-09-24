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
from app.services import job_lease
from app.services.connection_alerts import run_connection_alerts
from app.services import membership_alerts

logger = logging.getLogger(__name__)

# Hourly. See the module docstring for why this is not daily.
TICK_SECONDS = 3600

# Longer than a tick so the holder keeps its own lease between runs, and
# short enough that a replica dying does not strand the job for a day.
_LEASE_TTL_SECONDS = TICK_SECONDS * 2

# Runs this loop in-process. Same reasoning as the reminder dispatcher: right
# for one instance, wrong for several, where every replica would sync every
# account and multiply the provider bill by the replica count.
RUN_IN_PROCESS = os.environ.get("RUN_FINANCE_SCHEDULER", "1") != "0"


async def materialise_recurring(today: date | None = None) -> dict:
    """Move each recurring rule on to its next date, and say when it is due.

    RECURRING RULES DO NOT TOUCH THE LEDGER.
    This used to insert a finance entry for every occurrence — a Claude
    subscription on the 26th became a -24 row in the account on the 26th. Two
    things were wrong with that. It is not what a subscription list is for:
    it is a calendar of what will be charged, so you are not surprised, not a
    record of what was. And on any account connected to a bank it counts the
    same payment twice, because the bank sync imports the real charge as
    well. The ledger is what actually happened; rules only warn.
    """
    today = today or datetime.now(timezone.utc).date()
    rules = await accounts_db.fetch_due_recurring(today)
    if not rules:
        return {"rules": 0, "entries": 0}

    written = 0
    for rule in rules:
        try:
            occurrences, next_run = recurring.occurrences_due(rule, today)
            # Nothing is written to finance_entries — see the docstring.

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
                # A fresh occurrence resets the warning ladder: next month's
                # renewal has had nothing said about it yet.
                patch["notified_stage"] = None
                patch["notified_for"] = None

            await accounts_db.update_recurring(
                rule["id"], rule["owner_id"], patch
            )

            # Said on the day an occurrence falls due. Worded as "due today",
            # not "charged": nothing here observed the charge, so claiming
            # money moved would be a guess presented as a fact.
            if occurrences:
                try:
                    await membership_alerts.notify_renewed(rule)
                except Exception as exc:  # noqa: BLE001 — a push must not undo a write
                    logger.warning(
                        "Renewal notice failed for %s: %s", rule.get("id"), exc
                    )
        except Exception as exc:  # noqa: BLE001 — one rule must not stop the rest
            logger.error("Recurring rule %s failed: %s", rule.get("id"), exc)

    # Always 0 now; kept in the result so callers and the API shape are
    # unchanged.
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

    # After the sync too, so a consent that lapsed during THIS tick is
    # reported in the same pass rather than an hour later.
    try:
        connection_result = await run_connection_alerts(now)
    except Exception as exc:  # noqa: BLE001 — alerts must not break the tick
        logger.error("Connection alerts failed: %s", exc)
        connection_result = {"checked": 0, "notified": 0}

    # Renewal warnings run last, after materialisation has advanced any rule
    # that fired today — otherwise a rule that just renewed would still look
    # like it renews in zero days.
    try:
        membership_result = await membership_alerts.run_membership_alerts(now)
    except Exception as exc:  # noqa: BLE001 — alerts must not break the tick
        logger.error("Membership alerts failed: %s", exc)
        membership_result = {"checked": 0, "notified": 0}

    return {
        "recurring": recurring_result,
        "bank_sync": sync_result,
        "budgets": budget_result,
        "connections": connection_result,
        "memberships": membership_result,
    }


async def run_forever() -> None:
    """Background loop. Started from main.py's lifespan, cancelled on shutdown."""
    logger.info("Finance scheduler started (every %ss)", TICK_SECONDS)
    while True:
        try:
            await asyncio.sleep(TICK_SECONDS)
            # Only one replica may run this. Duplicate reminders are
            # annoying; duplicate bank syncs are billed, because bank data
            # is priced per connected account per month and every replica
            # would sync every account.
            if not await job_lease.hold("finance_scheduler", _LEASE_TTL_SECONDS):
                continue
            result = await run_once()
            if (
                result["recurring"]["entries"]
                or result["bank_sync"]["imported"]
                or result["budgets"]["notified"]
                or result["connections"]["notified"]
                or result["memberships"]["notified"]
            ):
                logger.info("Finance tick: %s", result)
        except asyncio.CancelledError:
            logger.info("Finance scheduler stopping")
            await job_lease.release("finance_scheduler")
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must outlive any tick
            logger.error("Finance tick failed: %s", exc)
