from datetime import datetime, timezone

from app.models.task import TaskBubble


def _deadline_weight(due_at: datetime | None) -> float:
    """Score urgency based on how close the due date is.

    Uses a stepped scale so the score accelerates as the deadline closes in.
    Returns 0 if no due date is set — absence of a deadline is not urgency.

    Scale:
        overdue       → 10
        ≤ 1 day away  → 8
        ≤ 3 days away → 5
        ≤ 7 days away → 2
        > 7 days away → 0
    """
    if due_at is None:
        return 0.0

    now = datetime.now(timezone.utc)

    # Ensure due_at is timezone-aware for a safe comparison
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)

    days_remaining = (due_at - now).total_seconds() / 86400

    if days_remaining < 0:
        return 10.0
    if days_remaining <= 1:
        return 8.0
    if days_remaining <= 3:
        return 5.0
    if days_remaining <= 7:
        return 2.0
    return 0.0


def _importance_weight(importance: int) -> float:
    """Map task importance (1–10) to a 0.5–5.0 pressure contribution.

    Dividing by 2 keeps importance from dominating the total score while still
    letting it meaningfully differentiate high- from low-priority tasks.
    """
    return importance / 2.0


def _dependency_weight(dependency_count: int) -> float:
    """Add pressure when other tasks or people are blocked by this one.

    Even a single dependency materially raises the cost of delay, so the jump
    from 0 → 1 dependency is intentionally significant.

    Scale:
        0 dependencies → 0
        1–2            → 1
        3+             → 2
    """
    if dependency_count == 0:
        return 0.0
    if dependency_count <= 2:
        return 1.0
    return 2.0


def _attention_decay(updated_at: datetime) -> float:
    """Revive neglected tasks that have been untouched for a long time.

    Without this, tasks with no deadline silently stagnate. The decay
    nudges them back into view before they become genuinely forgotten.

    Scale:
        untouched > 14 days → 3
        untouched > 7 days  → 1.5
        otherwise           → 0
    """
    now = datetime.now(timezone.utc)

    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)

    days_since_update = (now - updated_at).total_seconds() / 86400

    if days_since_update > 14:
        return 3.0
    if days_since_update > 7:
        return 1.5
    return 0.0


def calculate_pressure_score(task: TaskBubble, dependency_count: int = 0) -> float:
    """Compute a pressure score (0–10) for a TaskBubble.

    Pressure represents how urgently this task demands attention right now.
    It is a deterministic calculation — no AI, no randomness, no side effects.
    The result should be stored on task.pressure_score and recalculated
    whenever the task or its dependencies change.

    Components:
        deadline_weight    — urgency from proximity to due date     (0–10)
        importance_weight  — cost of delay based on importance      (0.5–5)
        dependency_weight  — blast radius if this task is blocked   (0–2)
        attention_decay    — revival bonus for long-neglected tasks  (0–3)

    The raw sum is clamped to [0, 10] so the score always fits the bubble
    radius scale used in the frontend universe renderer.
    """
    raw_score = (
        _deadline_weight(task.due_at)
        + _importance_weight(task.importance)
        + _dependency_weight(dependency_count)
        + _attention_decay(task.updated_at)
    )

    return round(min(max(raw_score, 0.0), 10.0), 4)
