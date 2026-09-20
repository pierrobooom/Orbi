"""Spending limits, and telling the user before they blow through one.

WHY THIS IS PURE ARITHMETIC
Comparing a sum against a number does not need a model, and routing it
through one would make a reliable fact occasionally wrong while costing
tokens. The AI's job with budgets comes later and is different: explaining
WHY dining doubled, or proposing a limit that suits how someone actually
spends. Deciding whether 412 is more than 400 is not that job.

TWO ALERTS, NOT ONE, AND NOT MANY
A limit is useful before it is hit, so the first alert fires at the user's
threshold — 80% by default — while there is still something to decide. A
second fires when the limit is actually exceeded, because "you're close" and
"you've gone past" call for different reactions.

Everything after that is silence for the rest of the month. An app that says
"over budget" every hour for three weeks is one the user turns off entirely,
and then it cannot tell them anything.

WHAT THE SWEEP DELIBERATELY DOES NOT DO
It does not spend the reminder budget. Task reminders are rationed by
proactivity level because there can be dozens of them; budget alerts are at
most two per category per MONTH, and suppressing one because a user had a
busy morning of task nudges would hide the one notification with money
attached to it.

It does respect quiet hours. Nothing about a spending limit is worth 3am.
"""

import logging
from collections import defaultdict
from datetime import date, datetime, timezone
from uuid import UUID

from app.db import (
    device_tokens as device_tokens_db,
    finance as finance_db,
)
from app.db.client import get_client
from app.services.push import send_push
from app.services.reminder_schedule import in_quiet_hours, resolve_zone

logger = logging.getLogger(__name__)

# Fired when the limit itself is passed, on top of the user's own warning
# threshold. Kept separate from alert_threshold so a user who sets a 95%
# warning still gets told when they actually go over.
_EXCEEDED = 1.0

# Below this a percentage is noise: a 5-euro limit crossed by 50 cents is
# "10% over" and not worth a notification.
_MIN_LIMIT = 10.0

_COPY = {
    "en": {
        "warn": ("Getting close on {category}", "{spent} of {limit} — {pct}% of the month's limit."),
        "over": ("Over budget on {category}", "{spent} spent against a {limit} limit."),
    },
    "pt": {
        "warn": ("A aproximar-te do limite em {category}", "{spent} de {limit} — {pct}% do limite do mês."),
        "over": ("Limite ultrapassado em {category}", "{spent} gastos contra um limite de {limit}."),
    },
}


def _money(amount: float, currency: str) -> str:
    symbol = {"EUR": "€", "GBP": "£", "USD": "$"}.get(currency.upper(), "")
    return f"{symbol}{amount:.2f}"


def evaluate_budgets(
    budgets: list[dict], entries: list[dict], month: str
) -> list[dict]:
    """Which budgets have crossed a level they have not been told about.

    Pure: takes rows, returns decisions. No database, no network, so the
    once-per-level-per-month rule is testable against fixed data rather than
    by watching whether a phone buzzes twice.
    """
    spend: dict[str, float] = defaultdict(float)
    for entry in entries:
        if entry.get("entry_type") != "expense":
            continue
        if str(entry.get("entry_date"))[:7] != month:
            continue
        spend[entry.get("category") or "uncategorized"] += float(entry.get("amount") or 0)

    due: list[dict] = []
    for budget in budgets:
        if not budget.get("alerts_enabled", True):
            continue

        limit = float(budget.get("monthly_limit") or 0)
        if limit < _MIN_LIMIT:
            continue

        category = budget.get("category") or ""
        spent = spend.get(category, 0.0)
        fraction = spent / limit

        threshold = float(budget.get("alert_threshold") or 0.8)
        # Highest level crossed, preferring the more serious message when both
        # apply — someone who lands straight past the limit should be told
        # they are over, not that they are getting close.
        if fraction >= _EXCEEDED:
            level, kind = _EXCEEDED, "over"
        elif fraction >= threshold:
            level, kind = threshold, "warn"
        else:
            continue

        # Already said, this month, at this level or worse.
        same_period = budget.get("notified_period") == month
        already = float(budget.get("notified_level") or 0.0)
        if same_period and already >= level:
            continue

        due.append(
            {
                "budget": budget,
                "category": category,
                "spent": round(spent, 2),
                "limit": limit,
                "fraction": fraction,
                "level": level,
                "kind": kind,
            }
        )
    return due


async def run_budget_alerts(now: datetime | None = None) -> dict:
    """Check every user's limits and notify on newly crossed levels."""
    now = now or datetime.now(timezone.utc)
    month = now.strftime("%Y-%m")

    client = get_client()
    rows = (
        client.table("finance_budgets")
        .select("*")
        .eq("alerts_enabled", True)
        .execute()
        .data
        or []
    )
    if not rows:
        return {"checked": 0, "notified": 0}

    by_user: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_user[str(row["user_id"])].append(row)

    notified = 0
    for user_id, budgets in by_user.items():
        try:
            notified += await _alert_user(UUID(user_id), budgets, month, now)
        except Exception as exc:  # noqa: BLE001 — one user must not stop the rest
            logger.error("Budget alerts failed for %s: %s", user_id, exc)

    return {"checked": len(rows), "notified": notified}


async def _alert_user(
    user_id: UUID, budgets: list[dict], month: str, now: datetime
) -> int:
    from app.services.reminder_dispatcher import preferences_for

    entries = await finance_db.fetch_entries_for_user(user_id, month=month)
    due = evaluate_budgets(budgets, entries, month)
    if not due:
        return 0

    prefs = await preferences_for(user_id)
    if not prefs.get("reminders_enabled", True):
        return 0

    # Quiet hours apply. Nothing about a spending limit is worth 3am — and
    # unlike a task reminder there is no deadline being missed by waiting, so
    # this simply returns and the next hourly tick picks it up.
    zone = resolve_zone(prefs.get("timezone"))
    from datetime import time as _time

    def _parse(value, fallback):
        try:
            return _time.fromisoformat(str(value))
        except (ValueError, TypeError):
            return fallback

    if in_quiet_hours(
        now.astimezone(zone),
        _parse(prefs.get("quiet_hours_start"), _time(22, 0)),
        _parse(prefs.get("quiet_hours_end"), _time(8, 0)),
    ):
        return 0

    tokens = await device_tokens_db.list_tokens_for_user(user_id)
    if not tokens:
        # No device to reach. Leave notified_level untouched so the alert is
        # still owed once they register one, rather than being marked as sent
        # to nobody.
        return 0

    language = prefs.get("language")
    copy = _COPY["pt"] if (language or "").lower().startswith("pt") else _COPY["en"]
    currency = str(entries[0].get("currency") or "EUR") if entries else "EUR"

    sent = 0
    client = get_client()
    for item in due:
        title_template, body_template = copy[item["kind"]]
        label = item["category"].replace("_", " ").title()
        values = {
            "category": label,
            "spent": _money(item["spent"], currency),
            "limit": _money(item["limit"], currency),
            "pct": int(item["fraction"] * 100),
        }

        tickets = await send_push(
            tokens,
            title=title_template.format(**values),
            body=body_template.format(**values),
            # Money moving past a line the user drew themselves is worth
            # breaking Focus for, the same as a deadline passing.
            interruption_level="time-sensitive",
            data={"kind": "budget", "category": item["category"]},
        )
        if not any(t.get("status") == "ok" for t in tickets):
            logger.warning(
                "Budget alert rejected for %s/%s", user_id, item["category"]
            )
            continue

        # Recorded only after a ticket came back ok, so a rejected push is
        # retried next tick rather than silently marked as delivered.
        client.table("finance_budgets").update(
            {"notified_level": item["level"], "notified_period": month}
        ).eq("id", item["budget"]["id"]).execute()
        sent += 1

    return sent
