"""Finance agent — categorises unknown merchants, generates insights, and answers queries.

Handles three finance operations:
1. AI-based categorisation for merchants not matched by rule-based categoriser
2. Spending insight generation from summary data
3. Natural language answers to finance questions
"""

import json
import logging

from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("finance_agent")


async def categorize_unknown_merchant(
    merchant: str,
    user_tier: str,
) -> dict:
    """Use AI to categorise a merchant when rule-based matching fails.

    Args:
        merchant:  The merchant name to categorise.
        user_tier: Subscription tier for AI routing.

    Returns:
        {"category": str, "confidence": float}
        Falls back to "other" with low confidence on failure.
    """
    prompt = f"Categorize this merchant: {merchant}"

    raw = await get_ai_response(
        prompt=prompt,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        max_tokens=100,
    )

    try:
        result = json.loads(raw)
        if "category" not in result:
            raise ValueError("Missing 'category' in response")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Finance agent categorization failed: %s | raw=%s", exc, raw[:200])
        return {"category": "other", "confidence": 0.1}


async def generate_insights(
    spending_summary: dict,
    previous_month_summary: dict | None,
    budgets: list[dict],
    user_tier: str,
) -> list[dict]:
    """Generate spending insights by comparing current and previous period data.

    Args:
        spending_summary:       Current month totals by category.
        previous_month_summary: Previous month totals for comparison (or None).
        budgets:                User's budget envelopes with limits and thresholds.
        user_tier:              Subscription tier for AI routing.

    Returns:
        List of insight dicts with keys: insight_text, category, severity.
        Returns an empty list on failure.
    """
    context_parts = [f"Current month spending: {json.dumps(spending_summary)}"]

    if previous_month_summary:
        context_parts.append(f"Previous month spending: {json.dumps(previous_month_summary)}")

    if budgets:
        context_parts.append(f"Budget limits: {json.dumps(budgets)}")

    prompt = "Generate spending insights based on the data provided.\n\n" + "\n".join(context_parts)

    raw = await get_ai_response(
        prompt=prompt,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        max_tokens=600,
    )

    try:
        result = json.loads(raw)
        if not isinstance(result, list):
            raise ValueError("Expected a JSON array of insights")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Finance agent insights failed: %s | raw=%s", exc, raw[:200])
        return []


async def answer_finance_question(
    question: str,
    spending_data: dict,
    user_tier: str,
) -> str:
    """Answer a natural language question about the user's finances.

    Args:
        question:      The user's question.
        spending_data: Relevant finance data to ground the answer.
        user_tier:     Subscription tier for AI routing.

    Returns:
        A plain-English answer string.
    """
    prompt = (
        f"User question: {question}\n\n"
        f"Finance data: {json.dumps(spending_data)}"
    )

    return await get_ai_response(
        prompt=prompt,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        max_tokens=300,
    )
