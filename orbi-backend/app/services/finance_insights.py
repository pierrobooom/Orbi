"""Turn the dashboard's numbers into observations worth reading.

THE DIVISION OF LABOUR, AND WHY IT IS STRICT
The dashboard computes. This reads. Not one figure here is calculated by a
model: the totals, averages, deltas and rankings all arrive already correct
from services/finance_dashboard.py, and the prompt is forbidden from doing
arithmetic. Asking an LLM to add a column costs tokens to do a SUM() and
occasionally gets it wrong, and a finance app that is occasionally wrong
about a number is worse than one that says nothing.

What a model is genuinely good at is the sentence after the number: noticing
that three of the five biggest merchants are food delivery, that a
subscription has quietly outgrown the category it sits in, that this month
looks like last month except for one thing. None of that is a query.

WHY THE DETERMINISTIC PASS RUNS FIRST
Some observations are worth making every time and do not need a model at
all: a limit about to be breached, a subscription that got more expensive, a
category at triple its average. Those are generated as plain rules here, and
they are the ones a free-tier user still gets. The AI adds to that list; it
does not replace it. It also means a model outage degrades to fewer
insights, not none.

COST
One call per user per day at most, and only when something changed. Insights
are the most expensive thing in the finance feature and the easiest to
regenerate pointlessly — a screen that refreshed them on every open would
quietly become the largest line on the bill.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from app.agents._utils import strip_json_fences
from app.services.ai_router import AIRateLimited, get_ai_response, load_prompt

logger = logging.getLogger(__name__)

# At most one AI generation per user per day. The deterministic rules below
# are free and re-run on every read.
MIN_HOURS_BETWEEN_GENERATIONS = 20

# Below this a month is too thin to say anything honest about.
_MIN_ENTRIES = 4

_SEVERITY = ("info", "warning", "alert")


def deterministic_insights(dashboard: dict, limits: list[dict]) -> list[dict]:
    """Observations that are true by arithmetic, so no model is involved.

    These are the ones a free-tier user still gets, and the ones that survive
    a provider outage. Each is a rule that would be embarrassing to get wrong
    and trivial to get right.
    """
    out: list[dict] = []
    month = dashboard.get("month")

    # A category running far above its own history. Reported only when there
    # is history to compare against — see the dashboard for why "no baseline"
    # and "no change" must never render as the same thing.
    for category in dashboard.get("categories") or []:
        change = category.get("change_pct")
        if change is None or change < 60:
            continue
        out.append(
            {
                "insight_text": (
                    f"{_label(category['category'])} is {int(change)}% above your "
                    f"usual — {category['amount']:.2f} against a typical "
                    f"{category['average']:.2f}."
                ),
                "category": category["category"],
                "subject": category["category"],
                "severity": "warning" if change >= 120 else "info",
                "period": month,
            }
        )

    # A limit on course to be passed. The alert sweep fires at the threshold;
    # this is the quieter version that shows up in a list rather than as a
    # notification, and it names the number needed to stay inside.
    for limit in limits:
        fraction = limit.get("fraction")
        if fraction is None or fraction < 0.6 or fraction >= 1:
            continue
        out.append(
            {
                "insight_text": (
                    f"You have {limit['remaining']:.2f} left of your "
                    f"{limit['monthly_limit']:.2f} {_label(limit['category'])} limit."
                ),
                "category": limit["category"],
                "subject": limit["category"],
                "severity": "info",
                "period": month,
            }
        )

    # One merchant dominating the month. A category tells you what kind of
    # spending; a merchant tells you where to actually change something.
    merchants = dashboard.get("top_merchants") or []
    total = dashboard.get("total_spend") or 0
    if merchants and total > 0:
        top = merchants[0]
        share = top["amount"] / total
        if share >= 0.3 and top["count"] >= 2:
            out.append(
                {
                    "insight_text": (
                        f"{top['merchant']} accounts for {int(share * 100)}% of this "
                        f"month's spending across {top['count']} transactions."
                    ),
                    "category": "uncategorized",
                    "subject": top["merchant"],
                    "severity": "info",
                    "period": month,
                }
            )

    # Uncategorised spending makes every other figure less trustworthy, so
    # say so rather than quietly reporting numbers built on a gap.
    uncategorised = dashboard.get("uncategorised_count") or 0
    if uncategorised >= 5:
        out.append(
            {
                "insight_text": (
                    f"{uncategorised} transactions have no category yet. Sorting "
                    "them makes everything else here more accurate."
                ),
                "category": "uncategorized",
                "subject": None,
                "severity": "info",
                "period": month,
            }
        )

    return out


def _label(slug: str) -> str:
    return (slug or "other").replace("_", " ").title()


def _facts_for_model(dashboard: dict, limits: list[dict]) -> str:
    """The prompt's entire input: numbers already computed, nothing raw.

    Deliberately not the transaction list. Sending a month of rows would cost
    a great deal, invite the model to do arithmetic it is bad at, and put the
    user's full spending history through a third party for no gain.
    """
    return json.dumps(
        {
            "month": dashboard.get("month"),
            "total_spend": dashboard.get("total_spend"),
            "total_income": dashboard.get("total_income"),
            "net": dashboard.get("net"),
            "average_spend": dashboard.get("average_spend"),
            "spend_change_pct": dashboard.get("spend_change_pct"),
            "months_of_history": dashboard.get("months_compared"),
            "categories": [
                {
                    "name": c["category"],
                    "amount": c["amount"],
                    "share_pct": c["share_pct"],
                    "average": c.get("average"),
                    "change_pct": c.get("change_pct"),
                }
                for c in (dashboard.get("categories") or [])[:8]
            ],
            "top_merchants": dashboard.get("top_merchants") or [],
            "limits": [
                {
                    "category": l["category"],
                    "limit": l["monthly_limit"],
                    "spent": l["spent"],
                }
                for l in limits
            ],
        },
        separators=(",", ":"),
    )


async def generate_ai_insights(
    dashboard: dict,
    limits: list[dict],
    user_id: UUID,
    user_tier: str,
) -> list[dict]:
    """Ask the model what is worth noticing. Returns [] on any failure.

    Every failure path is silent-and-empty rather than raising: insights are
    an enhancement, and a model outage must degrade the screen to the
    deterministic rules rather than breaking it.
    """
    if (dashboard.get("entry_count") or 0) < _MIN_ENTRIES:
        return []

    try:
        raw = await get_ai_response(
            prompt=_facts_for_model(dashboard, limits),
            user_id=user_id,
            user_tier=user_tier,
            system_prompt=load_prompt("finance_insights"),
            intent="monthly_synthesis",
            max_tokens=500,
        )
    except AIRateLimited:
        logger.info("Insight generation skipped — rate limited")
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning("Insight generation failed: %s", exc)
        return []

    try:
        parsed = json.loads(strip_json_fences(raw))
        if not isinstance(parsed, list):
            raise ValueError("expected a JSON array")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Insight response unparseable: %s | raw=%s", exc, raw[:200])
        return []

    month = dashboard.get("month")
    out: list[dict] = []
    for item in parsed[:5]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("insight_text") or "").strip()
        # A model that produced no text produced nothing, whatever else the
        # object contains.
        if not text:
            continue
        severity = str(item.get("severity") or "info").lower()
        out.append(
            {
                "insight_text": text[:400],
                "category": str(item.get("category") or "uncategorized")[:40],
                "subject": (str(item.get("subject")) or None) if item.get("subject") else None,
                "severity": severity if severity in _SEVERITY else "info",
                "period": month,
            }
        )
    return out


def should_regenerate(latest_created_at, now: datetime | None = None) -> bool:
    """Has enough time passed to justify another AI call?

    No history means yes. Anything within the window means no — a screen that
    regenerated on every open would be the largest line on the bill, and the
    observations would not meaningfully differ between two views an hour
    apart.
    """
    if not latest_created_at:
        return True
    now = now or datetime.now(timezone.utc)
    try:
        last = datetime.fromisoformat(str(latest_created_at).replace("Z", "+00:00"))
    except ValueError:
        return True
    return now - last >= timedelta(hours=MIN_HOURS_BETWEEN_GENERATIONS)


def build_rows(insights: list[dict], user_id: UUID) -> list[dict]:
    """Shape insights for finance_insights."""
    return [
        {
            "id": str(uuid4()),
            "user_id": str(user_id),
            "insight_text": item["insight_text"],
            "category": item.get("category") or "uncategorized",
            "severity": item.get("severity") or "info",
            "subject": item.get("subject"),
            "period": item.get("period"),
        }
        for item in insights
    ]
