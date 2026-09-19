import math
from datetime import datetime, timezone

from app.models.task import TaskBubble


def _deadline_weight(due_at: datetime | None) -> float:
    """Score urgency from how close the deadline is. Continuous, not stepped.

    This used to be a step function — a flat 10 for anything overdue and a
    flat 8 for anything from one minute to twenty-three hours away — and that
    made postponing a task do nothing observable. Push a deadline back an
    hour and the score was identical; push it back six and it was still
    identical. Since bubble size is drawn from this number, the bubble kept
    screaming at full volume about a task the user had just dealt with.

    Worse, the plateaus collapsed most of the universe onto one value: every
    active task due within a day rendered at exactly the same size, which is
    the opposite of what a pressure-ranked view is for.

    So it is a curve now. Every change to a deadline moves the score, by an
    amount proportional to how much the deadline moved — an hour is a nudge,
    a day is visible, a week is dramatic.

        3 days overdue   10.0      at the deadline   8.0
        1 day overdue     8.7      1 day away        6.4
        just overdue      8.0      3 days away       4.1
                                   7 days away       1.7
                                   14 days away      0.4

    Returns 0 with no due date: absence of a deadline is not urgency.
    """
    if due_at is None:
        return 0.0

    now = datetime.now(timezone.utc)

    # Ensure due_at is timezone-aware for a safe comparison
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)

    days_remaining = (due_at - now).total_seconds() / 86400

    if days_remaining < 0:
        # Being overdue still escalates, but it tops out: something three
        # days late and something three weeks late are both simply late, and
        # letting age dominate would bury genuinely urgent new work.
        return min(10.0, 8.0 + 2.0 * min(-days_remaining / 3.0, 1.0))

    # Exponential decay rather than a cliff. The half-life is tuned so the
    # curve passes close to the old steps at 1, 3 and 7 days, which keeps
    # existing tasks ranked roughly where their owner expects them.
    return 8.0 * math.exp(-days_remaining / 4.5)


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

    The raw sum can reach 20, and it used to be hard-clamped into [0, 10].
    That clamp was quietly destroying information: an ordinary task due
    tomorrow already summed past 10, so it scored identically to the most
    catastrophic thing in the universe, and any change to any component
    below the ceiling moved nothing at all. Postponing, de-prioritising or
    unblocking a task all looked like doing nothing.

    Soft saturation instead. The curve is strictly monotonic, so every
    change to every component always moves the score, while still
    approaching 10 asymptotically and never exceeding it — which is what the
    bubble radius scale needs. Nothing is ever *maximally* urgent, which is
    also true.
    """
    raw_score = (
        _deadline_weight(task.due_at)
        + _importance_weight(task.importance)
        + _dependency_weight(dependency_count)
        + _attention_decay(task.updated_at)
    )

    return round(10.0 * (1.0 - math.exp(-max(raw_score, 0.0) / 6.0)), 4)
