"""Tests for when a shared task closes.

This is the rule the whole feature turns on, and the one nobody can verify by
looking at it — a threshold that is wrong by one either lets a single person
close something other people are still doing, or leaves a task open for ever
because someone stopped using the app.
"""

from app.services.task_sharing import tally, threshold


def share(status="accepted", completed=False, user="u"):
    return {
        "status": status,
        "completed_at": "2026-09-22T10:00:00Z" if completed else None,
        "shared_with_user_id": user,
    }


# ---------------------------------------------------------------------------
# The threshold
# ---------------------------------------------------------------------------

def test_alone_is_not_a_vote():
    """An unshared task closes because its owner said so. There is nobody to
    agree with."""
    assert threshold(1) == 1


def test_two_people_both_have_to_agree():
    """The case the user described: one marks it done, the other confirms.
    That falls out of 'majority' rather than being special cased — a
    majority of two is two."""
    assert threshold(2) == 2


def test_three_people_need_two():
    assert threshold(3) == 2


def test_four_people_need_three():
    """Not two. Half is not a majority, and a rule that let half close it
    would mean two people overruling two."""
    assert threshold(4) == 3


def test_five_people_need_three():
    assert threshold(5) == 3


def test_the_threshold_is_always_more_than_half():
    for n in range(1, 30):
        assert threshold(n) * 2 > n


# ---------------------------------------------------------------------------
# Counting who is in
# ---------------------------------------------------------------------------

def test_pending_invitations_do_not_count_as_participants():
    """Otherwise sharing with four people who never answer makes a task
    impossible to close for the two actually doing it."""
    result = tally(False, [share(status="pending"), share(status="pending")])
    assert result["participants"] == 1
    assert result["needed"] == 1


def test_a_declined_share_is_not_a_participant():
    result = tally(False, [share(status="declined")])
    assert result["participants"] == 1


def test_the_owner_is_always_a_participant():
    """They are not in the shares table, and forgetting them would make a
    task shared with one person close on that person's word alone."""
    assert tally(False, [])["participants"] == 1
    assert tally(False, [share()])["participants"] == 2


# ---------------------------------------------------------------------------
# Closing
# ---------------------------------------------------------------------------

def test_an_unshared_task_closes_on_the_owner():
    assert tally(True, [])["complete"] is True


def test_one_of_two_is_not_enough():
    """The moment the user cares about: they marked it done, and it stays
    open until the other person agrees."""
    result = tally(True, [share()])
    assert result["complete"] is False
    assert (result["votes"], result["needed"]) == (1, 2)


def test_two_of_two_closes_it():
    assert tally(True, [share(completed=True)])["complete"] is True


def test_the_other_person_can_be_the_first_to_say_so():
    """Nothing about this is owner-first. Either may start it."""
    result = tally(False, [share(completed=True)])
    assert (result["votes"], result["needed"], result["complete"]) == (1, 2, False)


def test_two_of_three_closes_it_without_the_third():
    result = tally(True, [share(completed=True, user="a"), share(user="b")])
    assert result["complete"] is True
    assert result["pending_user_ids"] == ["b"]


def test_one_of_three_does_not():
    result = tally(True, [share(user="a"), share(user="b")])
    assert result["complete"] is False
    assert sorted(result["pending_user_ids"]) == ["a", "b"]


def test_two_of_four_does_not_close_it():
    """Half is not a majority — this would be two people overruling two."""
    result = tally(True, [share(completed=True), share(user="b"), share(user="c")])
    assert (result["votes"], result["needed"], result["complete"]) == (2, 3, False)


# ---------------------------------------------------------------------------
# Who is being waited on
# ---------------------------------------------------------------------------

def test_the_waiting_list_excludes_people_who_already_agreed():
    result = tally(False, [share(completed=True, user="a"), share(user="b")])
    assert result["pending_user_ids"] == ["b"]


def test_the_waiting_list_excludes_unanswered_invitations():
    """They were never asked to finish it — they were asked to join."""
    result = tally(False, [share(status="pending", user="a")])
    assert result["pending_user_ids"] == []
