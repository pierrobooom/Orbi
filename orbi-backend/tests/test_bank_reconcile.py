"""Tests for trimming duplicate bank rows against the bank's own feed.

This is the safety net behind dedup. Dedup decides what to insert and can
only ever apply the identity rule it was written with; this compares what
we hold against what the bank reports and removes our surplus.

The important tests here are the ones about what it must NOT delete.
"""

from app.services.bank_reconcile import surplus_ids


def key_of(row: dict) -> str:
    return f"{row['entry_date']}|{row['amount']:.2f}|{row['description'].lower()}"


def row(id_: str, date: str, amount: float, description: str, created: str) -> dict:
    return {
        "id": id_,
        "entry_date": date,
        "amount": amount,
        "description": description,
        "created_at": created,
    }


DINNER = "COMPRA 8430968.24 HAMBURGUERIAS ENIGMA"


# ---------------------------------------------------------------------------
# What it removes
# ---------------------------------------------------------------------------

def test_the_second_copy_of_one_dinner_is_removed():
    """The reported bug: the bank says once, we stored it twice."""
    stored = [
        row("a", "2026-09-23", 42.50, DINNER, "2026-09-23T21:50:58"),
        row("b", "2026-09-23", 42.50, DINNER, "2026-09-24T00:30:03"),
    ]
    expected = {key_of(stored[0]): 1}
    assert surplus_ids(stored, expected, key_of) == ["b"]


def test_the_oldest_copy_is_the_one_kept():
    """The first import is the row carrying any correction the user has
    since made to it by hand, such as a category they fixed."""
    stored = [
        row("newest", "2026-09-23", 42.50, DINNER, "2026-09-24T00:30:03"),
        row("oldest", "2026-09-23", 42.50, DINNER, "2026-09-23T21:50:58"),
    ]
    assert surplus_ids(stored, {key_of(stored[0]): 1}, key_of) == ["newest"]


def test_several_extra_copies_all_go():
    stored = [
        row(str(i), "2026-09-23", 42.50, DINNER, f"2026-09-2{i}T00:00:00")
        for i in range(1, 5)
    ]
    assert surplus_ids(stored, {key_of(stored[0]): 1}, key_of) == ["2", "3", "4"]


# ---------------------------------------------------------------------------
# What it must never remove
# ---------------------------------------------------------------------------

def test_a_key_the_feed_never_mentions_is_left_alone():
    """The line this must not cross.

    A short feed — a partial page, an outage mid-window, a bank narrowing
    its own history — would otherwise wipe real transactions. Absence of a
    key is not evidence that it never happened.
    """
    stored = [
        row("a", "2026-09-23", 42.50, DINNER, "2026-09-23T21:50:58"),
        row("b", "2026-09-23", 42.50, DINNER, "2026-09-24T00:30:03"),
    ]
    assert surplus_ids(stored, {}, key_of) == []


def test_an_empty_feed_deletes_nothing_at_all():
    """The worst case of the above: the bank returned nothing."""
    stored = [row(str(i), "2026-09-23", 5.00, "TOP-UP", f"2026-09-2{i}T00:00:00")
              for i in range(1, 6)]
    assert surplus_ids(stored, {}, key_of) == []


def test_genuine_repeats_are_kept_when_the_bank_confirms_them():
    """Four separate five-euro transfers on one day are four transactions,
    not one transaction stored four times."""
    stored = [
        row(str(i), "2026-09-19", 5.00, "SENT FROM REVOLUT", f"2026-09-19T15:2{i}:00")
        for i in range(1, 5)
    ]
    assert surplus_ids(stored, {key_of(stored[0]): 4}, key_of) == []


def test_holding_fewer_than_the_bank_reports_removes_nothing():
    """Under-count is the dedup's problem to solve by inserting, never this
    one's to solve by deleting."""
    stored = [row("a", "2026-09-19", 5.00, "SENT FROM REVOLUT", "2026-09-19T15:23:00")]
    assert surplus_ids(stored, {key_of(stored[0]): 3}, key_of) == []


def test_one_key_being_over_does_not_touch_a_different_key():
    duplicated = row("dup", "2026-09-23", 42.50, DINNER, "2026-09-24T00:30:03")
    original = row("orig", "2026-09-23", 42.50, DINNER, "2026-09-23T21:50:58")
    unrelated = row("other", "2026-09-23", 9.99, "SOMETHING ELSE", "2026-09-23T10:00:00")
    stored = [original, duplicated, unrelated]
    expected = {key_of(original): 1, key_of(unrelated): 1}
    assert surplus_ids(stored, expected, key_of) == ["dup"]


def test_nothing_stored_is_not_an_error():
    assert surplus_ids([], {"anything": 3}, key_of) == []


def test_the_decision_does_not_mutate_what_it_was_given():
    stored = [
        row("a", "2026-09-23", 42.50, DINNER, "2026-09-23T21:50:58"),
        row("b", "2026-09-23", 42.50, DINNER, "2026-09-24T00:30:03"),
    ]
    expected = {key_of(stored[0]): 1}
    before = [dict(r) for r in stored]
    surplus_ids(stored, expected, key_of)
    assert expected == {key_of(before[0]): 1}
    assert sorted(r["id"] for r in stored) == ["a", "b"]
