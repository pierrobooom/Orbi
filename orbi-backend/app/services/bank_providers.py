"""Bank data providers, behind one interface.

WHY THIS IS AN INTERFACE AND NOT AN INTEGRATION
Reading someone's bank transactions in the EU means being a licensed AISP,
authorised by the national regulator and holding an eIDAS certificate. Nobody
does that themselves for a side project; everybody rents it from an aggregator
that holds the licence. Which aggregator is an open question right now —
GoCardless/Nordigen, the free default, closed to new signups; Enable Banking is
the current self-serve route — and the answer changes an adapter, not a schema
and not a scheduler.

So everything above this file is written against `fetch_transactions`, and the
vendor decision stays a forty-line class.

WHAT AN ADAPTER NEEDS, AND WHY IT IS NOT THE IBAN
An IBAN says WHICH account. It does not say the holder agreed to share it. The
consent flow is always: the user is sent to their own bank, authenticates there
with their own credentials and 2FA, approves a named provider for a named
scope, and the bank issues a token back. `consent_reference` on the connection
is that token's handle. An adapter that only had the IBAN would have nothing to
authenticate with, which is why NullProvider exists and returns nothing rather
than pretending.

COST SHAPE
Providers price per connected account per month, and several meter calls on
top. The scheduler therefore syncs each account at most once a day and each
adapter is handed a date window rather than being asked to stream. One call,
one window, one account — the cost per user is then flat and knowable in
advance, which is the only version of this that fits a £10.99 tier.
"""

import logging
import os
from dataclasses import dataclass
from datetime import date
from typing import Protocol

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BankTransaction:
    """One transaction, normalised away from whatever shape the provider used.

    `external_id` is the load-bearing field. A daily sync re-requests an
    overlapping window every time — deliberately, because banks post
    transactions late and a non-overlapping window would lose them — so the
    same transaction arrives repeatedly and the unique index on
    (user_id, external_id) is what makes that harmless. An adapter that cannot
    supply a stable id from the provider must synthesise a deterministic one
    (hash of date + amount + description), never a random one.
    """

    external_id: str
    booked_on: date
    # Signed: negative is money leaving. Providers disagree about this — some
    # send a sign, some send a separate credit/debit flag — so normalising it
    # here keeps the sign convention out of the sync loop.
    amount: float
    currency: str
    description: str
    merchant: str | None = None


class BankProvider(Protocol):
    """What the sync loop needs from any aggregator."""

    name: str

    async def fetch_transactions(
        self,
        *,
        external_account_id: str | None,
        consent_reference: str | None,
        since: date,
        until: date,
    ) -> list[BankTransaction]:
        """Return transactions in [since, until]. Raises on a real failure.

        Returning an empty list means "the account had no activity"; raising
        means "we could not ask". The sync loop treats those very differently —
        the first is a normal quiet day, the second marks the connection
        errored and backs off.
        """
        ...


class ConsentExpired(Exception):
    """The user must re-authenticate at their bank before this will work.

    Distinct from a transport error because the remedy is completely
    different: nothing retries its way out of an expired consent, and the
    user has to be told rather than quietly retried at.
    """


class NullProvider:
    """The provider used until a real one is configured.

    Returns nothing, every time, and says so once at startup. It exists so the
    entire pipeline — scheduling, claiming, windowing, deduplication, filing to
    the right account, categorisation — is exercised and testable before any
    vendor contract exists, and so a missing configuration degrades to "no bank
    transactions" instead of an exception on a background thread.
    """

    name = "manual"

    async def fetch_transactions(
        self,
        *,
        external_account_id: str | None,
        consent_reference: str | None,
        since: date,
        until: date,
    ) -> list[BankTransaction]:
        return []


_REGISTRY: dict[str, BankProvider] = {}


def register(provider: BankProvider) -> None:
    """Add a provider. Adapters call this at import time."""
    _REGISTRY[provider.name] = provider


def get_provider(name: str | None) -> BankProvider:
    """Return the named provider, or the null one.

    Never raises on an unknown name. A typo in a config value must not stop
    the scheduler for every other user on the instance.
    """
    if not name:
        return _NULL
    provider = _REGISTRY.get(name)
    if provider is None:
        logger.warning("Unknown bank provider %r — falling back to null", name)
        return _NULL
    return provider


def configured_provider_name() -> str:
    """Which provider new connections should be created against.

    Read from the environment so switching aggregators is a deploy, not a
    migration. Defaults to the null provider, which is the honest default:
    nothing is connected until someone configures it.
    """
    return os.environ.get("BANK_PROVIDER", "manual").strip() or "manual"


_NULL = NullProvider()
register(_NULL)
