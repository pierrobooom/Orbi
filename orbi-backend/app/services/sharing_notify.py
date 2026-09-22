"""Telling people what happened to a task they share.

WHY THESE FOUR AND NOT MORE
A shared task generates a lot of events, and most of them are nobody's
business. What gets sent is only what changes what someone should DO:

    invited        — there is a decision waiting for you
    joined         — the person you asked said yes, so this is now joint
    waiting on you — someone says it is done and it closes when you agree
    closed         — it is finished, stop carrying it

Deliberately silent: declining. A notification saying someone turned you
down turns a small private act into a social one, and there is nothing to
do about it.

WHO DOES NOT GET TOLD
The person who acted. They know — they just tapped the thing. Sending it
back to them is the oldest bug in shared apps and the one users notice
first.
"""

import logging
from uuid import UUID

from app.db import device_tokens as device_tokens_db
from app.services.push import send_push

logger = logging.getLogger(__name__)

_COPY = {
    "en": {
        "invited": ("{who} shared a task with you", "“{title}” — tap to accept or decline."),
        "joined": ("{who} joined “{title}”", "You are both on this now."),
        "waiting": (
            "{who} says “{title}” is done",
            "Confirm on your side and it closes for everyone. {votes} of {needed} so far.",
        ),
        "closed": ("“{title}” is done", "Everyone agreed. It is off your list."),
    },
    "pt": {
        "invited": ("{who} partilhou uma tarefa contigo", "“{title}” — toca para aceitar ou recusar."),
        "joined": ("{who} juntou-se a “{title}”", "Agora é de ambos."),
        "waiting": (
            "{who} diz que “{title}” está feita",
            "Confirma do teu lado e fecha para todos. {votes} de {needed} até agora.",
        ),
        "closed": ("“{title}” está feita", "Todos concordaram. Saiu da tua lista."),
    },
}


async def _push(user_id: UUID, kind: str, values: dict, data: dict) -> None:
    """Send one sharing notification, or quietly do nothing.

    Every failure path is silent. A push that does not arrive is a smaller
    problem than an exception unwinding the request that was doing the actual
    work — the state change has already been written by the time this runs.
    """
    from app.services.reminder_dispatcher import preferences_for

    try:
        prefs = await preferences_for(user_id)
        if not prefs.get("reminders_enabled", True):
            return
        tokens = await device_tokens_db.list_tokens_for_user(user_id)
        if not tokens:
            return

        language = (prefs.get("language") or "en").lower()
        copy = _COPY["pt" if language.startswith("pt") else "en"][kind]
        await send_push(
            tokens,
            title=copy[0].format(**values),
            body=copy[1].format(**values),
            # Shared work is about other people waiting. "Someone is held up
            # by you" is the one notification in the app that is genuinely
            # about somebody else's time, not yours.
            interruption_level="time-sensitive",
            data=data,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Sharing notification (%s) failed: %s", kind, exc)


def _name(profile: dict | None) -> str:
    return (profile or {}).get("full_name") or "Someone"


def _title(task: dict) -> str:
    return (task.get("label") or task.get("title") or "A task")[:60]


async def invited(task: dict, sender: dict | None, recipient_id: UUID) -> None:
    await _push(
        recipient_id,
        "invited",
        {"who": _name(sender), "title": _title(task)},
        {"kind": "share_invite", "task_id": str(task["id"])},
    )


async def joined(task: dict, joiner: dict | None, owner_id: UUID) -> None:
    await _push(
        owner_id,
        "joined",
        {"who": _name(joiner), "title": _title(task)},
        {"kind": "share_joined", "task_id": str(task["id"])},
    )


async def waiting_on_you(
    task: dict,
    shares: list[dict],
    owner_id: UUID,
    actor_id: UUID,
    actor: dict | None,
    state: dict,
) -> None:
    """Tell the participants who have not voted that they are holding it up.

    Only those who have NOT voted. Someone who already agreed has done their
    part and telling them again would be asking twice for the same thing.
    """
    values = {
        "who": _name(actor),
        "title": _title(task),
        "votes": state["votes"],
        "needed": state["needed"],
    }
    data = {"kind": "share_vote", "task_id": str(task["id"])}

    targets = {UUID(uid) for uid in state["pending_user_ids"]}
    # The owner is not in the shares table, so their vote has to be checked
    # separately or they would never be asked to confirm.
    if not task.get("owner_completed_at"):
        targets.add(owner_id)
    targets.discard(actor_id)

    for target in targets:
        await _push(target, "waiting", values, data)


async def closed(
    task: dict, shares: list[dict], owner_id: UUID, actor_id: UUID
) -> None:
    """Tell everyone it is finished — except whoever just finished it."""
    values = {"title": _title(task)}
    data = {"kind": "share_closed", "task_id": str(task["id"])}

    targets = {
        UUID(str(r["shared_with_user_id"]))
        for r in shares
        if r.get("status") == "accepted" and r.get("shared_with_user_id")
    }
    targets.add(owner_id)
    targets.discard(actor_id)

    for target in targets:
        await _push(target, "closed", values, data)
