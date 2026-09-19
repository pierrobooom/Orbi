"""Expo Push API client.

Sends notifications to one or more Expo push tokens. Expo's HTTP endpoint
accepts up to 100 messages per request and returns one ticket per message.
A ticket can be:
   - {"status": "ok", "id": "..."}        — accepted, ID is for receipt lookup
   - {"status": "error", "message": ...}   — rejected (bad token, payload, etc.)

We don't poll receipts in this slice — that's the next slice's job, where
we'd act on DeviceNotRegistered errors by deleting the token. For now we
just log failures so the dev can see them.
"""

import logging
from typing import Iterable

import httpx

logger = logging.getLogger(__name__)

_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
_BATCH_SIZE = 100  # Expo's documented per-request maximum


async def send_push(
    tokens: Iterable[str],
    *,
    title: str,
    body: str,
    data: dict | None = None,
    subtitle: str | None = None,
    category_id: str | None = None,
    interruption_level: str | None = None,
) -> list[dict]:
    """Fan out a push to every token. Returns the list of tickets Expo returned.

    Empty token list short-circuits without touching the network.

    `subtitle` is an iOS-only second line, rendered between the title and
    the body. Android ignores it, so nothing essential may live there.

    `category_id` names a set of action buttons the CLIENT registered with
    setNotificationCategoryAsync. It has to be a TOP-LEVEL field: it was
    originally passed inside `data`, where Expo never looks for it, so the
    buttons silently never appeared on a notification that otherwise
    worked perfectly.

    `interruption_level` is how loud iOS is allowed to be:
      passive       — no sound, no screen, straight to the list
      active        — the default: sound, screen lights up
      timeSensitive — also breaks through Focus and Do Not Disturb, which is
                      what WhatsApp and Teams use for messages
      critical      — overrides the silent switch; needs a special
                      entitlement Apple grants case by case, and is for
                      safety alerts, not reminders. Never used here.

    timeSensitive needs the com.apple.developer.usernotifications.time-sensitive
    entitlement, which only exists in a real build of the app — not in Expo
    Go. Sending it anyway is safe: without the entitlement iOS quietly treats
    it as `active`, so this is correct now and louder later with no change.
    """
    token_list = [t for t in tokens if t]
    if not token_list:
        return []

    tickets: list[dict] = []
    async with httpx.AsyncClient(timeout=10.0) as client:
        for start in range(0, len(token_list), _BATCH_SIZE):
            batch = token_list[start : start + _BATCH_SIZE]
            messages = [
                {
                    "to": tok,
                    "title": title,
                    "body": body,
                    "data": data or {},
                    "sound": "default",
                    **({"subtitle": subtitle} if subtitle else {}),
                    **({"categoryId": category_id} if category_id else {}),
                    **(
                        {"interruptionLevel": interruption_level}
                        if interruption_level
                        else {}
                    ),
                }
                for tok in batch
            ]
            try:
                resp = await client.post(
                    _EXPO_PUSH_URL,
                    json=messages,
                    headers={
                        "Accept": "application/json",
                        "Accept-encoding": "gzip, deflate",
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                body_json = resp.json()
                batch_tickets = body_json.get("data", [])
                # Log any errors so dev can spot them in the backend output.
                for ticket in batch_tickets:
                    if ticket.get("status") == "error":
                        logger.warning(
                            "Expo push error: %s | details=%s",
                            ticket.get("message"),
                            ticket.get("details"),
                        )
                tickets.extend(batch_tickets)
            except httpx.HTTPStatusError as exc:
                # Log the RESPONSE BODY, not just the status. A 400 from Expo
                # is a payload validation failure and the body names the
                # offending field and its allowed values — without it, a
                # one-character mistake in an enum ('timeSensitive' where the
                # push API wants 'time-sensitive') silently kills every
                # notification and reads only as "400 Bad Request".
                detail = ""
                try:
                    detail = exc.response.text[:500]
                except Exception:  # noqa: BLE001
                    pass
                logger.error("Expo push rejected (%s): %s", exc.response.status_code, detail)
                tickets.extend(
                    [{"status": "error", "message": detail or str(exc)} for _ in batch]
                )
                continue
            except httpx.HTTPError as exc:
                logger.error("Expo push transport error: %s", exc)
                # Synthesise an error ticket per token so the caller sees
                # the failure shape rather than thinking the call worked.
                tickets.extend(
                    [{"status": "error", "message": str(exc)} for _ in batch]
                )

    return tickets
