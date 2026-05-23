"""Cluster manager agent — assigns tasks to clusters and suggests reorganisation.

Handles semantic grouping of TaskBubbles into Clusters. Uses AI to determine
the best cluster for a task and to suggest merges, splits, and renames.
"""

import json
import logging
from uuid import UUID

from app.agents._utils import strip_json_fences
from app.services.ai_router import get_ai_response, load_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = load_prompt("cluster_manager")
# v2 covers the proposal mode used by /clusters/auto-organize. Kept
# alongside v1 so the single-task assignment path stays untouched.
_PROPOSAL_PROMPT = load_prompt("cluster_manager", version=2)

# Allowed proposal action types. Mirrors cluster_manager_v2.md exactly.
# Anything outside this set is dropped during validation.
_PROPOSAL_ACTION_TYPES = frozenset({
    "create_cluster", "move_tasks", "merge_clusters", "rename_cluster",
})
_MAX_PROPOSAL_ACTIONS = 5


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
        result = json.loads(strip_json_fences(raw))
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
        result = json.loads(strip_json_fences(raw))
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Cluster manager reorg failed: %s | raw=%s", exc, raw[:200])
        return {"suggestions": []}


async def propose_organisation(
    clusters: list[dict],
    tasks: list[dict],
    user_id: UUID,
    user_tier: str,
) -> dict:
    """Ask the LLM for a structured reorganisation proposal.

    Read-only. Returns a dict of the shape::

        {"actions": [
            {"type": "create_cluster", "name": ..., "color": ...,
             "task_ids": [...], "reason": ...},
            ...
        ]}

    The mobile reviews each action with a checkbox; only approved
    actions reach apply_organisation. Server never mutates here.

    Args:
        clusters: List of {"id", "name", "task_count"} entries.
        tasks:    List of {"id", "title", "label", "domain_hint",
                  "parent_cluster_id"} entries. Tasks with
                  parent_cluster_id=None are in Drift.
        user_id:  Authenticated user — for quota tracking only.
        user_tier: Tier string for AI routing.

    Returns:
        Always {"actions": [...]} — empty list on parse failure rather
        than raising, because a degraded proposal is fine UX (the
        mobile shows "nothing to suggest"). Invalid action entries are
        silently filtered.
    """
    prompt = (
        f"CLUSTERS:\n{json.dumps(clusters, indent=2)}\n\n"
        f"TASKS:\n{json.dumps(tasks, indent=2)}"
    )

    raw = await get_ai_response(
        prompt=prompt,
        user_id=user_id,
        user_tier=user_tier,
        system_prompt=_PROPOSAL_PROMPT,
        intent="daily_chat",
        max_tokens=900,
    )

    try:
        parsed = json.loads(strip_json_fences(raw))
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Cluster proposal parse failed: %s | raw=%s", exc, raw[:200])
        return {"actions": []}

    raw_actions = parsed.get("actions") if isinstance(parsed, dict) else None
    if not isinstance(raw_actions, list):
        return {"actions": []}

    # Build a set of known ids so we can drop any hallucinated ones
    # before the apply step ever sees them. The agent's prompt forbids
    # invented ids but Llama 8B doesn't always listen.
    known_cluster_ids = {str(c.get("id")) for c in clusters if c.get("id")}
    known_task_ids = {str(t.get("id")) for t in tasks if t.get("id")}
    drift_task_ids = {
        str(t.get("id"))
        for t in tasks
        if t.get("id") and not t.get("parent_cluster_id")
    }

    cleaned: list[dict] = []
    for action in raw_actions:
        if not isinstance(action, dict):
            continue
        action_type = action.get("type")
        if action_type not in _PROPOSAL_ACTION_TYPES:
            continue
        validated = _validate_action(
            action,
            known_cluster_ids=known_cluster_ids,
            known_task_ids=known_task_ids,
            drift_task_ids=drift_task_ids,
        )
        if validated is not None:
            cleaned.append(validated)
        if len(cleaned) >= _MAX_PROPOSAL_ACTIONS:
            break

    return {"actions": cleaned}


def _validate_action(
    action: dict,
    *,
    known_cluster_ids: set[str],
    known_task_ids: set[str],
    drift_task_ids: set[str],
) -> dict | None:
    """Return a cleaned action or None if it can't be salvaged.

    Hallucinated ids are stripped, not corrected — there's no safe way
    to guess what the LLM meant. If stripping leaves an action
    semantically empty (e.g. create_cluster with zero task_ids), drop
    the whole action.
    """
    a_type = action["type"]
    reason = str(action.get("reason", "")).strip() or "Suggested by the cluster manager."

    if a_type == "create_cluster":
        name = str(action.get("name", "")).strip()
        color = str(action.get("color", "")).strip() or "#7C6FE0"
        raw_ids = action.get("task_ids") or []
        task_ids = [
            tid for tid in (str(x) for x in raw_ids if x)
            if tid in drift_task_ids  # only Drift tasks may seed a new cluster
        ]
        # Enforce min 2 tasks — single-task clusters aren't worth creating.
        if not name or len(task_ids) < 2:
            return None
        return {
            "type": "create_cluster",
            "name": name[:40],
            "color": color,
            "task_ids": task_ids,
            "reason": reason,
        }

    if a_type == "move_tasks":
        cluster_id = str(action.get("cluster_id", "")).strip()
        raw_ids = action.get("task_ids") or []
        task_ids = [
            tid for tid in (str(x) for x in raw_ids if x)
            if tid in known_task_ids
        ]
        if cluster_id not in known_cluster_ids or not task_ids:
            return None
        return {
            "type": "move_tasks",
            "cluster_id": cluster_id,
            "task_ids": task_ids,
            "reason": reason,
        }

    if a_type == "merge_clusters":
        source_id = str(action.get("source_id", "")).strip()
        target_id = str(action.get("target_id", "")).strip()
        if source_id == target_id:
            return None
        if source_id not in known_cluster_ids or target_id not in known_cluster_ids:
            return None
        return {
            "type": "merge_clusters",
            "source_id": source_id,
            "target_id": target_id,
            "reason": reason,
        }

    if a_type == "rename_cluster":
        cluster_id = str(action.get("cluster_id", "")).strip()
        new_name = str(action.get("new_name", "")).strip()
        if cluster_id not in known_cluster_ids or not new_name:
            return None
        return {
            "type": "rename_cluster",
            "cluster_id": cluster_id,
            "new_name": new_name[:40],
            "reason": reason,
        }

    return None


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
