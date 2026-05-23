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
) -> list[dict]:
    """Fan out a push to every token. Returns the list of tickets Expo returned.

    Empty token list short-circuits without touching the network.
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
            except httpx.HTTPError as exc:
                logger.error("Expo push HTTP error: %s", exc)
                # Synthesise an error ticket per token so the caller sees
                # the failure shape rather than thinking the call worked.
                tickets.extend(
                    [{"status": "error", "message": str(exc)} for _ in batch]
                )

    return tickets
