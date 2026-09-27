"""A checklist description survives the sanitiser whole.

The AI writes an errand's items as "- [ ] item" lines. The sanitiser caps
description length, and a cut in the middle of a line left the list ending
on half an item ("- [ ] Bre").
"""

from app.services.task_sanitizer import _DESCRIPTION_MAX_LEN, sanitize_parsed_task


def _clean(description: str) -> str | None:
    return sanitize_parsed_task({"title": "Buy groceries", "description": description}).get("description")


def test_a_checklist_is_kept_line_for_line():
    checklist = "- [ ] Milk\n- [ ] Eggs\n- [x] Bread"
    assert _clean(checklist) == checklist


def test_an_overlong_checklist_loses_whole_items_not_half_of_one():
    items = [f"- [ ] Item number {n}" for n in range(60)]
    cleaned = _clean("\n".join(items))
    assert cleaned is not None
    assert len(cleaned) <= _DESCRIPTION_MAX_LEN
    assert all(line in items for line in cleaned.split("\n"))


def test_a_dozen_items_fit():
    items = [f"- [ ] Grocery item {n}" for n in range(12)]
    assert _clean("\n".join(items)).count("- [ ]") == 12
