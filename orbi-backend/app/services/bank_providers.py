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


@dataclass(frozen=True)
class ConnectionDraft:
    """What a provider gives back when a user starts connecting an account.

    `authorization_url` is the heart of it, and the reason connecting can
    never be a field on a form: for any real provider the user has to be sent
    to their OWN BANK, authenticate there with their own credentials and 2FA,
    and approve a named provider for a named scope. Only then does a token
    come back. A draft with no URL means the provider needs no such trip —
    true only for the sandbox, which speaks to nobody.

    `status` is 'pending' while that trip is outstanding and 'active' once
    there is something usable to sync with.
    """

    external_account_id: str | None = None
    consent_reference: str | None = None
    consent_expires_at: str | None = None
    authorization_url: str | None = None
    status: str = "pending"
    institution_id: str | None = None


class ProviderNotConfigured(Exception):
    """No aggregator is set up, so there is nothing to connect to.

    Raised rather than returning an empty draft so the caller is forced to
    tell the user plainly instead of creating a connection that will silently
    never produce anything.
    """


class BankProvider(Protocol):
    """What the sync loop needs from any aggregator."""

    name: str

    async def begin_connection(
        self,
        *,
        account: dict,
        redirect_uri: str | None = None,
        institution: str | None = None,
        country: str | None = None,
    ) -> ConnectionDraft:
        """Start linking one account. Raises ProviderNotConfigured if it cannot.

        `institution` is WHICH BANK, chosen per connection rather than set
        globally: users do not all bank in the same place, and a deployment-
        wide default silently sends everyone to one institution.

        `account` carries the user's own record — including the IBAN they
        typed, which is used afterwards to match the approved account. It is
        never the thing that grants access.
        """
        ...

    async def fetch_transactions(
        self,
        *,
        external_account_id: str | None,
        consent_reference: str | None,
        since: date,
        until: date,
        psu: dict[str, str] | None = None,
    ) -> list[BankTransaction]:
        """Return transactions in [since, until]. Raises on a real failure.

        Returning an empty list means "the account had no activity"; raising
        means "we could not ask". The sync loop treats those very differently —
        the first is a normal quiet day, the second marks the connection
        errored and backs off.
        """
        ...


class RateLimited(Exception):
    """The bank has refused because we have read this account too often today.

    Not an error with the connection. PSD2 lets a bank cap reads made while
    the user is not present at about four a day per account; past that it
    answers 429 until the window rolls over. The consent is still valid and
    nothing about it needs fixing — which is exactly why this must never be
    reported the way a broken connection is.
    """


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
        psu: dict[str, str] | None = None,
    ) -> list[BankTransaction]:
        return []

    async def begin_connection(
        self, *, account: dict, redirect_uri: str | None = None,
        institution: str | None = None, country: str | None = None,
    ) -> ConnectionDraft:
        raise ProviderNotConfigured(
            "No bank provider is configured, so accounts cannot be connected. "
            "Transactions come from manual entry, receipts and recurring rules."
        )


class SandboxProvider:
    """Fabricated transactions, for exercising the pipeline. NEVER real data.

    This exists to answer one question — does the machinery work? — without a
    vendor contract: does a sync claim the connection, honour the cooldown,
    deduplicate an overlapping window, file to the right account, and run the
    categoriser. It cannot answer whether a bank would return anything,
    because it never speaks to one.

    Every transaction it emits is labelled DEMO in the description and its
    external_id is prefixed `sandbox:`, so fabricated rows can always be told
    apart from real ones and deleted in a single query. That labelling is not
    decoration: financial records that cannot be distinguished from real ones
    are how someone ends up making a decision on invented numbers.

    Off unless BANK_PROVIDER=sandbox is set explicitly.
    """

    name = "sandbox"

    # Deterministic, so a re-sync of an overlapping window returns the SAME
    # transactions and the deduplication is actually being tested rather than
    # being handed fresh ids every time.
    _PATTERN = [
        (0, -12.40, "DEMO Continente", "Continente"),
        (1, -3.20, "DEMO Padaria", "Padaria"),
        (2, -9.99, "DEMO Netflix", "Netflix"),
        (3, -24.80, "DEMO Galp", "Galp"),
        (5, -46.15, "DEMO Pingo Doce", "Pingo Doce"),
    ]

    async def fetch_transactions(
        self,
        *,
        external_account_id: str | None,
        consent_reference: str | None,
        since: date,
        until: date,
        psu: dict[str, str] | None = None,
    ) -> list[BankTransaction]:
        from datetime import timedelta

        out: list[BankTransaction] = []
        for offset, amount, description, merchant in self._PATTERN:
            booked = since + timedelta(days=offset)
            if booked > until:
                continue
            out.append(
                BankTransaction(
                    external_id=f"sandbox:{external_account_id or 'acct'}:{booked.isoformat()}:{merchant}",
                    booked_on=booked,
                    amount=amount,
                    currency="EUR",
                    description=description,
                    merchant=merchant,
                )
            )
        logger.warning(
            "SandboxProvider returned %s FABRICATED transactions — not real bank data",
            len(out),
        )
        return out

    async def begin_connection(
        self, *, account: dict, redirect_uri: str | None = None,
        institution: str | None = None, country: str | None = None,
    ) -> ConnectionDraft:
        """Connect immediately, with no authorisation trip.

        The sandbox is the only provider that can do this, precisely because
        it talks to no bank. Every real one returns an authorization_url and
        sits at 'pending' until the user has been to their bank and back.
        """
        logger.warning(
            "SandboxProvider connected account %s — FABRICATED data, no bank involved",
            account.get("id"),
        )
        return ConnectionDraft(
            external_account_id=f"sandbox-{str(account.get('id'))[:8]}",
            consent_reference="sandbox-no-consent-needed",
            status="active",
            institution_id="sandbox",
        )


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


# Adapters self-register on import. Imported at the bottom so the registry
# and the base types exist first.
from app.services import bank_provider_enablebanking  # noqa: E402,F401

_NULL = NullProvider()
register(_NULL)
# Registered but inert unless BANK_PROVIDER names it.
register(SandboxProvider())
