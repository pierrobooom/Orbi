"""Sharing a task, and agreeing when it is finished.

WHO COUNTS
The owner, plus everyone who accepted an invitation. A pending invite is
not a participant — someone who has not answered cannot be waited on, or a
task shared with four people who ignore it could never be closed by the two
who are actually doing it.

WHEN IT CLOSES
A majority of participants saying so:

    1 person   -> 1     (no vote to hold; it is just a task)
    2 people   -> 2     a majority of two is two
    3 people   -> 2
    4 people   -> 3
    5 people   -> 3

Majority rather than unanimity because unanimity gives every participant a
veto, and the common failure is not disagreement — it is someone who stopped
using the app. With three people, two who agree should not be held up by a
third who never opens it.

Two people is the exception that proves it: a majority of two IS two, so
sharing with one person behaves exactly as the user expects — both confirm,
and it closes. That falls out of the arithmetic rather than being special
cased.

WHY VOTES ARE TIMESTAMPS, NOT A COUNTER
The question the UI has to answer is "am I the one being waited on". A count
cannot answer it. A timestamp per participant can, and it also survives
someone changing their mind — withdrawing a vote is clearing a field rather
than decrementing something that might already have been acted on.
"""

import logging
from uuid import UUID

from app.db.client import get_client

logger = logging.getLogger(__name__)


def threshold(participant_count: int) -> int:
    """How many must agree before a shared task closes.

    Strict majority: more than half, rounded up. Derived rather than looked
    up so it stays right for group sizes nobody has tried yet.
    """
    if participant_count <= 1:
        return 1
    return participant_count // 2 + 1


def tally(owner_completed: bool, share_rows: list[dict]) -> dict:
    """Where a shared task stands: who is in, who has agreed, is it done.

    Pure, and deliberately the only place the rule lives. Returns everything
    the UI needs to explain the state, because "2 of 3" is a far better thing
    to show someone than a spinner or a silent refusal.
    """
    accepted = [r for r in share_rows if r.get("status") == "accepted"]
    participants = 1 + len(accepted)  # the owner is always a participant
    votes = (1 if owner_completed else 0) + sum(
        1 for r in accepted if r.get("completed_at")
    )
    needed = threshold(participants)
    return {
        "participants": participants,
        "votes": votes,
        "needed": needed,
        "complete": votes >= needed,
        # Who has not voted yet — the people a "waiting on" line names.
        "pending_user_ids": [
            str(r["shared_with_user_id"])
            for r in accepted
            if not r.get("completed_at") and r.get("shared_with_user_id")
        ],
    }


async def shares_for_task(task_id: UUID) -> list[dict]:
    """Every share on a task, whatever its state."""
    return (
        get_client()
        .table("task_shares")
        .select("*")
        .eq("task_id", str(task_id))
        .execute()
        .data
        or []
    )


async def is_participant(task_id: UUID, user_id: UUID) -> dict | None:
    """The accepted share linking this user to this task, if there is one.

    How the API answers "may this person touch a task they do not own".
    """
    rows = (
        get_client()
        .table("task_shares")
        .select("*")
        .eq("task_id", str(task_id))
        .eq("shared_with_user_id", str(user_id))
        .eq("status", "accepted")
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


async def claim_invites_for(user_id: UUID, email: str) -> int:
    """Attach any invitations waiting on this address to this account.

    Called when someone signs up, so inviting a person who has not joined yet
    is not a dead end. Without it, a share sent to a friend before they
    installed the app would sit unclaimed for ever and the sender would have
    to guess that they needed to send it again.
    """
    if not email:
        return 0
    rows = (
        get_client()
        .table("task_shares")
        .update({"shared_with_user_id": str(user_id)})
        .eq("invited_email", email.strip().lower())
        .is_("shared_with_user_id", "null")
        .execute()
        .data
        or []
    )
    if rows:
        logger.info("Linked %s waiting invitations to %s", len(rows), user_id)
    return len(rows)


async def fetch_share_for_recipient(share_id: UUID, user_id: UUID) -> dict | None:
    """An invitation addressed to this user, whatever its state.

    Scoped to the recipient so accepting or declining somebody else's
    invitation is a 404 rather than an authorisation check someone has to
    remember to write at each call site.
    """
    rows = (
        get_client()
        .table("task_shares")
        .select("*")
        .eq("id", str(share_id))
        .eq("shared_with_user_id", str(user_id))
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None
