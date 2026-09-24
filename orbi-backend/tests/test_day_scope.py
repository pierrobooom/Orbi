"""Tests for answering 'what do I have today' without a model.

The regressions: the chat answered "today" with the next seven days, and the
today filter compared UTC dates, so near midnight in Lisbon it counted a
task due tomorrow as today.
"""

from datetime import datetime, timezone

import pytest

from app.services.day_scope import detect, in_scope

LISBON = "Europe/Lisbon"


# ---------------------------------------------------------------------------
# Recognising the question
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "message",
    [
        "Que tarefas tenho hoje?",
        "O que tenho para fazer hoje?",
        "o que tenho hoje",
        "What do I have today?",
        "what tasks are due today?",
        "Tenho alguma tarefa hoje?",
    ],
)
def test_questions_about_today_are_recognised(message):
    assert detect(message) == "today"


@pytest.mark.parametrize(
    "message",
    ["O que tenho amanhã?", "Quais são as tarefas de amanhã?", "what do I have tomorrow?"],
)
def test_questions_about_tomorrow_are_recognised(message):
    assert detect(message) == "tomorrow"


@pytest.mark.parametrize(
    "message",
    [
        # A creation names a day and a verb too. It must go to the model.
        "Amanhã tenho que levar o carro à oficina, pelas 15 horas.",
        "Hoje tenho de ligar ao dentista",
        # Not about tasks at all.
        "hoje foi um dia longo",
        # A range, not a day: answering half of it would be wrong.
        "O que tenho hoje ou amanhã?",
        # Long messages are doing something else as well.
        "o que tenho hoje e também podes criar uma tarefa para comprar pão e leite amanhã de manhã cedo",
    ],
)
def test_other_messages_are_left_to_the_model(message):
    assert detect(message) is None


# ---------------------------------------------------------------------------
# Which tasks are "today", in the user's own calendar
# ---------------------------------------------------------------------------

# 23:30 in Lisbon on the 24th (UTC+1) — the hour the bug showed up.
LATE_EVENING = datetime(2026, 9, 24, 22, 30, tzinfo=timezone.utc)


def test_a_task_due_later_tonight_is_today():
    assert in_scope("2026-09-24T22:45:00Z", "today", LISBON, LATE_EVENING)


def test_a_task_due_tomorrow_morning_is_not_today():
    """The reported bug: this was returned as one of 'today's' two tasks."""
    assert not in_scope("2026-09-25T07:59:00Z", "today", LISBON, LATE_EVENING)
    assert in_scope("2026-09-25T07:59:00Z", "tomorrow", LISBON, LATE_EVENING)


def test_late_tasks_count_as_today():
    """They still need doing today — and the universe header counts them."""
    assert in_scope("2026-09-20T09:00:00Z", "today", LISBON, LATE_EVENING)


def test_late_tasks_do_not_count_as_tomorrow():
    assert not in_scope("2026-09-20T09:00:00Z", "tomorrow", LISBON, LATE_EVENING)


def test_just_after_local_midnight_uses_the_local_day():
    """00:30 in Lisbon is still 23:30 on the previous day in UTC. A task at
    00:45 local belongs to the new local day, whatever UTC says."""
    after_midnight = datetime(2026, 9, 24, 23, 30, tzinfo=timezone.utc)  # 00:30 on the 25th, Lisbon
    assert in_scope("2026-09-24T23:45:00Z", "today", LISBON, after_midnight)


def test_undated_tasks_have_no_today():
    assert not in_scope(None, "today", LISBON, LATE_EVENING)


def test_an_unknown_timezone_falls_back_rather_than_crashing():
    assert in_scope("2026-09-24T22:45:00Z", "today", "Not/AZone", LATE_EVENING)
