"""Enable Banking adapter — real PSD2 transactions, on your own accounts, free.

WHY THIS ONE
GoCardless/Nordigen, the free default everyone used, closed to new signups.
Enable Banking is the current self-serve route for the EU, and it has the
property that matters here: **Restricted Production**. Activate an application
by linking your OWN bank accounts in their control panel, and the API serves
live data from those accounts with no commercial contract, no KYB, and no
cost. The API filters responses to the linked accounts even if a user
authorises more, which is exactly the guard rail you want while testing.

So the wall was never "no API exists". It was that serving OTHER people's
accounts needs an AISP licence you rent from an aggregator. Serving your own
does not, and that is enough to run this feature for real today.

Going beyond your own accounts means a signed contract and KYB with Enable
Banking, priced by quote since April 2026. Price it before promising it to a
paying tier — see the ElevenLabs entry in CLAUDE.md for what happens
otherwise.

AUTH
A JWT signed with the application's RSA private key, `kid` set to the
application id, max 24h TTL. It identifies the APPLICATION, not a user — user
consent lives in the session, which is why `consent_reference` on a
connection stores the session id rather than a token.

THE CONSENT TRIP IS STILL THE CONSENT TRIP
POST /auth returns a URL the user must open and authenticate at, with their
own bank. They come back with a `code`, which POST /sessions exchanges for a
session id and the list of accounts they approved. No IBAN, anywhere, ever
substitutes for that round trip — the IBAN is only used afterwards, to match
the approved account to the finance_account the user already created.

CONFIGURATION
    BANK_PROVIDER=enablebanking
    ENABLE_BANKING_APP_ID=<application id from the control panel>
    ENABLE_BANKING_PRIVATE_KEY=<PEM contents, or a path to the .pem>
    ENABLE_BANKING_REDIRECT_URL=<your callback>
"""

import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

from app.services.bank_providers import (
    BankTransaction,
    ConnectionDraft,
    ConsentExpired,
    ProviderNotConfigured,
    register,
)

logger = logging.getLogger(__name__)

_BASE_URL = os.environ.get("ENABLE_BANKING_BASE_URL", "https://api.enablebanking.com")

# Their maximum is 86400. An hour is plenty for a daily sync and limits the
# blast radius if a token ever leaks into a log.
_TOKEN_TTL_SECONDS = 3600

# How long to ask consent for. PSD2 requires periodic re-authentication; 90
# days is the conservative figure and the app warns before it lapses either
# way, so guessing long buys nothing.
_CONSENT_DAYS = 90

_TIMEOUT = httpx.Timeout(20.0)


def _private_key() -> str:
    """The signing key, from the env directly or from a path it points at."""
    raw = os.environ.get("ENABLE_BANKING_PRIVATE_KEY", "").strip()
    if not raw:
        raise ProviderNotConfigured(
            "ENABLE_BANKING_PRIVATE_KEY is not set. Download the application's "
            "private key from the Enable Banking control panel."
        )
    # A path is far easier to configure than a multi-line PEM in an env var,
    # so both are accepted.
    if not raw.startswith("-----BEGIN"):
        path = Path(raw)
        if not path.exists():
            raise ProviderNotConfigured(
                f"ENABLE_BANKING_PRIVATE_KEY points at {raw}, which does not exist."
            )
        return path.read_text(encoding="utf-8")
    return raw


def _app_id() -> str:
    app_id = os.environ.get("ENABLE_BANKING_APP_ID", "").strip()
    if not app_id:
        raise ProviderNotConfigured(
            "ENABLE_BANKING_APP_ID is not set. Copy it from the Enable Banking "
            "control panel."
        )
    return app_id


def _build_jwt() -> str:
    """Sign a short-lived application token.

    jose is imported here rather than at module scope so that a deployment
    without the optional dependency still starts — it only fails when someone
    actually selects this provider, with a message saying what to install.
    """
    try:
        from jose import jwt  # python-jose, already a dependency
    except ImportError as exc:  # pragma: no cover — dependency is pinned
        raise ProviderNotConfigured(
            "python-jose is required for the Enable Banking provider."
        ) from exc

    now = int(time.time())
    return jwt.encode(
        {"iss": "enablebanking.com", "aud": "api.enablebanking.com",
         "iat": now, "exp": now + _TOKEN_TTL_SECONDS},
        _private_key(),
        algorithm="RS256",
        headers={"kid": _app_id()},
    )


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_build_jwt()}", "Accept": "application/json"}


def _parse_amount(transaction: dict) -> float | None:
    """Signed amount, negative for money leaving.

    Enable Banking reports magnitude and direction separately
    (`transaction_amount.amount` plus `credit_debit_indicator`), so the sign
    has to be reconstructed. Getting this backwards would file every expense
    as income and quietly double a balance rather than erroring.
    """
    amount_block = transaction.get("transaction_amount") or {}
    raw = amount_block.get("amount")
    if raw is None:
        return None
    try:
        magnitude = abs(float(raw))
    except (TypeError, ValueError):
        return None
    indicator = str(transaction.get("credit_debit_indicator") or "").upper()
    return magnitude if indicator == "CRDT" else -magnitude


def _parse_booked_on(transaction: dict) -> date | None:
    for field in ("booking_date", "value_date", "transaction_date"):
        raw = transaction.get(field)
        if not raw:
            continue
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).date()
        except ValueError:
            continue
    return None


def _describe(transaction: dict) -> tuple[str, str | None]:
    """(description, merchant) from whichever fields this bank populated.

    Banks are wildly inconsistent here: some fill creditor name, some put
    everything in remittance information, some only send a reference. Trying
    them in order beats picking one and getting blanks for half the feed.
    """
    remittance = transaction.get("remittance_information")
    if isinstance(remittance, list):
        remittance = " ".join(str(part) for part in remittance if part)

    creditor = (transaction.get("creditor") or {}).get("name")
    debtor = (transaction.get("debtor") or {}).get("name")
    merchant = creditor or debtor

    description = (
        remittance
        or merchant
        or transaction.get("reference_number")
        or transaction.get("entry_reference")
        or "Transaction"
    )
    return str(description).strip()[:500], (str(merchant).strip()[:200] if merchant else None)


class EnableBankingProvider:
    """Live PSD2 account data. Free against your own linked accounts."""

    name = "enablebanking"

    async def begin_connection(
        self, *, account: dict, redirect_uri: str | None = None
    ) -> ConnectionDraft:
        """Ask Enable Banking for an authorisation URL.

        Returns a PENDING draft carrying that URL. The connection only becomes
        usable once the user has been to their bank, approved, and the
        callback has exchanged the code for a session — which is the step no
        account number can stand in for.
        """
        redirect = redirect_uri or os.environ.get("ENABLE_BANKING_REDIRECT_URL", "").strip()
        if not redirect:
            raise ProviderNotConfigured("ENABLE_BANKING_REDIRECT_URL is not set.")

        aspsp_name = os.environ.get("ENABLE_BANKING_ASPSP", "Revolut").strip()
        aspsp_country = os.environ.get("ENABLE_BANKING_COUNTRY", "PT").strip()

        payload = {
            "access": {
                "valid_until": (
                    datetime.now(timezone.utc) + timedelta(days=_CONSENT_DAYS)
                ).isoformat()
            },
            "aspsp": {"name": aspsp_name, "country": aspsp_country},
            "redirect_url": redirect,
            "psu_type": "personal",
            "state": str(account.get("id") or ""),
        }

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                f"{_BASE_URL}/auth", json=payload, headers=_headers()
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Enable Banking /auth failed ({response.status_code}): "
                    f"{response.text[:300]}"
                )
            body = response.json()

        return ConnectionDraft(
            authorization_url=body.get("url"),
            # The authorization_id, not a session yet. The callback replaces
            # this with the real session id once the user returns.
            consent_reference=body.get("authorization_id"),
            consent_expires_at=payload["access"]["valid_until"],
            status="pending",
            institution_id=f"{aspsp_name}/{aspsp_country}",
        )

    async def complete_connection(self, *, code: str) -> dict:
        """Exchange the callback code for a session and its accounts.

        Returns the raw session body so the caller can match the approved
        accounts against the user's own records — by IBAN, which is finally
        the thing an IBAN is actually for.
        """
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                f"{_BASE_URL}/sessions", json={"code": code}, headers=_headers()
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Enable Banking /sessions failed ({response.status_code}): "
                    f"{response.text[:300]}"
                )
            return response.json()

    async def fetch_transactions(
        self,
        *,
        external_account_id: str | None,
        consent_reference: str | None,
        since: date,
        until: date,
    ) -> list[BankTransaction]:
        """One day's sync: a single windowed request, paged to completion."""
        if not external_account_id:
            # Authorised, but we never resolved which account. Returning
            # nothing is right — there is no sensible default account to
            # guess at.
            logger.warning("Enable Banking connection has no external_account_id")
            return []

        out: list[BankTransaction] = []
        continuation_key: str | None = None

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            while True:
                params: dict[str, str] = {
                    "date_from": since.isoformat(),
                    "date_to": until.isoformat(),
                }
                if continuation_key:
                    params["continuation_key"] = continuation_key

                response = await client.get(
                    f"{_BASE_URL}/accounts/{external_account_id}/transactions",
                    params=params,
                    headers=_headers(),
                )

                if response.status_code in (401, 403):
                    # The consent lapsed or was revoked at the bank. Distinct
                    # from a transport failure because no retry fixes it —
                    # only the user, at their bank.
                    raise ConsentExpired(
                        f"Enable Banking returned {response.status_code}; "
                        "the account needs reconnecting."
                    )
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Enable Banking transactions failed "
                        f"({response.status_code}): {response.text[:300]}"
                    )

                body = response.json()
                for transaction in body.get("transactions") or []:
                    parsed = self._to_transaction(transaction)
                    if parsed is not None:
                        out.append(parsed)

                continuation_key = body.get("continuation_key")
                if not continuation_key:
                    break

        return out

    @staticmethod
    def _to_transaction(transaction: dict) -> BankTransaction | None:
        booked_on = _parse_booked_on(transaction)
        amount = _parse_amount(transaction)
        if booked_on is None or amount is None or amount == 0:
            return None

        description, merchant = _describe(transaction)
        amount_block = transaction.get("transaction_amount") or {}

        # entry_reference is the bank's own stable id. When a bank omits it,
        # fall back to a deterministic composite — never a random id, which
        # would make every sync re-import the whole window.
        external_id = (
            transaction.get("entry_reference")
            or transaction.get("transaction_id")
            or f"{booked_on.isoformat()}:{amount:.2f}:{description[:40]}"
        )

        return BankTransaction(
            external_id=f"eb:{external_id}",
            booked_on=booked_on,
            amount=amount,
            currency=str(amount_block.get("currency") or "EUR"),
            description=description,
            merchant=merchant,
        )


register(EnableBankingProvider())
