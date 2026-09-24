"""Tests for which TaskBubble fields are allowed to reach the database.

The regression this exists for: sharing added four fields to TaskBubble
that are assembled per request from task_shares and are not columns on
task_bubbles. create_task dumped the whole model into an INSERT, PostgREST
rejected the unknown column, and creating ANY task returned 500 — for
everyone, whether or not they had ever shared anything.

Nothing in the type system catches that. This does.
"""

from datetime import datetime, timezone
from uuid import uuid4

from app.models.task import (
    TASK_DERIVED_FIELDS,
    TaskBubble,
    TaskStatus,
    persistable,
)


def a_task(**overrides) -> TaskBubble:
    now = datetime.now(timezone.utc)
    base = dict(
        id=uuid4(),
        owner_id=uuid4(),
        title="Buy brushes",
        status=TaskStatus.active,
        source_type="manual",
        importance=5,
        urgency_score=0.0,
        pressure_score=0.0,
        confidence=1.0,
        created_at=now,
        updated_at=now,
    )
    base.update(overrides)
    return TaskBubble(**base)


def test_no_derived_field_reaches_the_row():
    """The bug, stated directly."""
    row = persistable(a_task())
    assert TASK_DERIVED_FIELDS.isdisjoint(row.keys())


def test_a_derived_field_is_dropped_even_when_it_has_a_value():
    """Absent is not the same as null. A shared task read back from the API
    carries real values in these fields, and writing one of those back must
    still not send them."""
    task = a_task(shared_with_me=True, owner_completed_at=datetime.now(timezone.utc))
    row = persistable(task)
    assert "shared_with_me" not in row
    assert "owner_completed_at" not in row


def test_the_real_columns_all_survive():
    """The other half: dropping too much would be a quieter bug than
    dropping too little, because the row would simply be wrong."""
    row = persistable(a_task(label="Brushes", description="For the car"))
    for column in (
        "id",
        "owner_id",
        "title",
        "label",
        "description",
        "status",
        "importance",
        "pressure_score",
        "visibility",
        "created_at",
        "updated_at",
    ):
        assert column in row, f"{column} must be written"


def test_the_result_is_json_safe():
    """It goes to PostgREST, so a UUID or a datetime object left in place
    would fail at the HTTP boundary rather than here."""
    row = persistable(a_task())
    assert isinstance(row["id"], str)
    assert isinstance(row["created_at"], str)


def test_every_derived_name_is_actually_a_field():
    """Guards the set itself: a typo in TASK_DERIVED_FIELDS would exclude
    nothing and the 500 would come straight back."""
    fields = set(TaskBubble.model_fields.keys())
    assert TASK_DERIVED_FIELDS <= fields
