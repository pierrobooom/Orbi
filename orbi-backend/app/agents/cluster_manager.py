"""Cluster manager agent — assigns tasks to clusters and suggests reorganisation.

Handles semantic grouping of TaskBubbles into Clusters. Uses AI to determine
the best cluster for a task and to suggest merges, splits, and renames.
"""

import json
import logging
from uuid import UUID

from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("cluster_manager")


async def assign_task_to_cluster(
    task_title: str,
    task_description: str | None,
    domain_hint: str | None,
    existing_clusters: list[dict],
    user_id: UUID,
    user_tier: str,
) -> dict:
    """Suggest the best cluster for a task.

    Args:
        task_title:        The task's title.
        task_description:  Optional description for additional context.
        domain_hint:       Domain hint from the task parser (e.g. "work", "health").
        existing_clusters: List of current clusters with name, id, and task count.
        user_tier:         Subscription tier for AI routing.

    Returns:
        {
            "cluster_name": str,
            "cluster_id": str | None,
            "is_new_cluster": bool,
            "color_suggestion": str,
            "confidence": float
        }
    """
    prompt = (
        f"Task: {task_title}\n"
        f"Description: {task_description or 'None'}\n"
        f"Domain hint: {domain_hint or 'None'}\n\n"
        f"Existing clusters: {json.dumps(existing_clusters)}"
    )

    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent="daily_chat",
        max_tokens=200,
    )

    try:
        result = json.loads(raw)
        if "cluster_name" not in result:
            raise ValueError("Missing 'cluster_name' in response")
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Cluster manager assignment failed: %s | raw=%s", exc, raw[:200])
        # Fallback: use domain_hint to pick a default cluster name
        default_name = _domain_to_cluster_name(domain_hint)
        return {
            "cluster_name": default_name,
            "cluster_id": None,
            "is_new_cluster": True,
            "color_suggestion": "#7C6FE0",
            "confidence": 0.3,
        }


async def suggest_reorganisation(
    clusters: list[dict],
    user_id: UUID,
    user_tier: str,
) -> dict:
    """Suggest cluster merges, splits, renames, or archives.

    Args:
        clusters:  Full list of clusters with name, id, task_count, and summary.
        user_tier: Subscription tier for AI routing.

    Returns:
        {"suggestions": [{"action": str, "source": str, ...}]}
    """
    prompt = f"Review these clusters and suggest improvements:\n{json.dumps(clusters)}"

    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_SYSTEM_PROMPT,
        intent="daily_chat",
        max_tokens=500,
    )

    try:
        result = json.loads(raw)
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Cluster manager reorg failed: %s | raw=%s", exc, raw[:200])
        return {"suggestions": []}


def _domain_to_cluster_name(domain_hint: str | None) -> str:
    """Map a domain hint to a default cluster name."""
    mapping = {
        "work": "Work",
        "personal": "Personal",
        "health": "Health & Fitness",
        "finance": "Finance",
        "home": "Home",
        "social": "Social",
        "education": "Learning",
    }
    return mapping.get(domain_hint or "", "Uncategorised")
