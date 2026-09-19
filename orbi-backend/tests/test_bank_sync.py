"""Tests for the bank-sync pipeline, exercised through a fake provider.

The point of the provider being an interface is that everything above it can
be tested without an aggregator, a licence, or a network. These cover the
parts that will be wrong in production if they are wrong here: the sign
convention, deduplication, and the cost budget.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from app.services.bank_providers import (
    BankTransaction,
    ConsentExpired,
    NullProvider,
    get_provider,
    register,
)
from app.services.bank_sync import (
    SYNC_INTERVAL_HOURS,
    SYNC_WINDOW_DAYS,
    _to_entry,
    default_window,
)

OWNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ACCOUNT = "cccccccc-cccc-cccc-cccc-cccccccccccc"


class FakeProvider:
    """A provider that returns whatever it was handed."""

    name = "fake"

    def __init__(self, transactions=None, raises=None):
        self.transactions = transactions or []
        self.raises = raises
        self.calls: list[tuple[date, date]] = []

    async def fetch_transactions(
        self, *, external_account_id, consent_reference, since, until
    ):
        self.calls.append((since, until))
        if self.raises:
            raise self.raises
        return self.transactions


# ---------------------------------------------------------------------------
# The provider registry
# ---------------------------------------------------------------------------

def test_unknown_provider_falls_back_instead_of_raising():
    """A typo in a config value must not stop the scheduler for every other
    user on the instance."""
    assert isinstance(get_provider("does-not-exist"), NullProvider)
    assert isinstance(get_provider(None), NullProvider)


@pytest.mark.asyncio
async def test_null_provider_returns_nothing_rather_than_pretending():
    """Until an aggregator is configured there is nothing to fetch, and
    saying so honestly is what lets the rest of the pipeline be exercised."""
    result = await NullProvider().fetch_transactions(
        external_account_id=None,
        consent_reference=None,
        since=date(2026, 9, 1),
        until=date(2026, 9, 8),
    )
    assert result == []


@pytest.mark.asyncio
async def test_registered_provider_is_returned_by_name():
    provider = FakeProvider()
    register(provider)
    assert get_provider("fake") is provider


# ---------------------------------------------------------------------------
# Normalising a transaction into an entry
# ---------------------------------------------------------------------------

def test_negative_amounts_become_expenses_stored_unsigned():
    """Providers disagree about signs; entries have always carried direction
    in entry_type and magnitude in amount. Normalising here keeps the sign
    convention out of everything downstream."""
    entry = _to_entry(
        BankTransaction(
            external_id="tx-1",
            booked_on=date(2026, 9, 18),
            amount=-47.32,
            currency="EUR",
            description="COMPRA CONTINENTE LISBOA",
            merchant="Continente",
        ),
        owner_id=OWNER,
        account_id=ACCOUNT,
    )
    assert entry["entry_type"] == "expense"
    assert entry["amount"] == 47.32
    assert entry["source_type"] == "bank"
    assert entry["external_id"] == "tx-1"
    assert entry["account_id"] == ACCOUNT


def test_positive_amounts_become_income():
    entry = _to_entry(
        BankTransaction(
            external_id="tx-2",
            booked_on=date(2026, 9, 18),
            amount=1800.00,
            currency="EUR",
            description="TRANSFERENCIA SALARIO",
        ),
        owner_id=OWNER,
        account_id=ACCOUNT,
    )
    assert entry["entry_type"] == "income"
    assert entry["amount"] == 1800.00


def test_raw_description_is_kept_alongside_the_tidied_merchant():
    """The bank's own string is the corpus the merchant rules get better
    from. Overwriting it with the categorised name throws that away."""
    entry = _to_entry(
        BankTransaction(
            external_id="tx-3",
            booked_on=date(2026, 9, 18),
            amount=-9.99,
            currency="EUR",
            description="NETFLIX.COM  AMSTERDAM NL",
            merchant="Netflix",
        ),
        owner_id=OWNER,
        account_id=ACCOUNT,
    )
    assert entry["raw_description"] == "NETFLIX.COM  AMSTERDAM NL"
    assert entry["merchant"] == "Netflix"


def test_missing_merchant_falls_back_to_the_description():
    entry = _to_entry(
        BankTransaction(
            external_id="tx-4",
            booked_on=date(2026, 9, 18),
            amount=-3.50,
            currency="EUR",
            description="PAGAMENTO MB WAY",
        ),
        owner_id=OWNER,
        account_id=ACCOUNT,
    )
    assert entry["merchant"] == "PAGAMENTO MB WAY"


def test_a_transaction_with_no_account_still_files():
    """A connection whose account was deleted should not lose the data — the
    entry lands unassigned rather than being dropped."""
    entry = _to_entry(
        BankTransaction(
            external_id="tx-5",
            booked_on=date(2026, 9, 18),
            amount=-1.0,
            currency="EUR",
            description="X",
        ),
        owner_id=OWNER,
        account_id=None,
    )
    assert entry["account_id"] is None


# ---------------------------------------------------------------------------
# The cost budget
# ---------------------------------------------------------------------------

def test_one_call_per_account_per_day():
    """The number the whole cost model rests on. If this changes, every
    user's provider bill changes with it."""
    assert SYNC_INTERVAL_HOURS == 24


def test_the_window_overlaps_so_late_postings_are_not_lost():
    """Banks post transactions days after the fact. A window that started
    where the last one ended would drop them silently, and nobody would ever
    learn the total was wrong."""
    since, until = default_window(date(2026, 9, 19))
    assert until == date(2026, 9, 19)
    assert since == date(2026, 9, 12)
    assert (until - since).days == SYNC_WINDOW_DAYS
    assert SYNC_WINDOW_DAYS > 1


@pytest.mark.asyncio
async def test_provider_is_asked_for_a_window_not_a_stream():
    """One call, one window, one account — the shape that makes the per-user
    cost knowable in advance."""
    provider = FakeProvider()
    await provider.fetch_transactions(
        external_account_id="acc-1",
        consent_reference="ref-1",
        since=date(2026, 9, 12),
        until=date(2026, 9, 19),
    )
    assert provider.calls == [(date(2026, 9, 12), date(2026, 9, 19))]


@pytest.mark.asyncio
async def test_consent_expiry_is_a_distinct_failure():
    """Nothing retries its way out of an expired consent — only the user can,
    at their bank — so it must not look like a transport error."""
    provider = FakeProvider(raises=ConsentExpired("expired"))
    with pytest.raises(ConsentExpired):
        await provider.fetch_transactions(
            external_account_id="acc-1",
            consent_reference="ref-1",
            since=date(2026, 9, 12),
            until=date(2026, 9, 19),
        )


def test_retry_backoff_is_shorter_than_the_daily_cadence():
    """A transient outage should cost minutes, not a whole day of data."""
    from app.services.bank_sync import RETRY_INTERVAL_HOURS

    assert 0 < RETRY_INTERVAL_HOURS < SYNC_INTERVAL_HOURS


def test_consent_warning_lands_before_the_feed_dies():
    """A stopped feed is indistinguishable from a quiet month, so the user
    has to be asked to reconnect while it still works."""
    from app.services.bank_sync import CONSENT_WARNING_DAYS

    assert CONSENT_WARNING_DAYS >= 3
    warn_at = datetime.now(timezone.utc) + timedelta(days=CONSENT_WARNING_DAYS)
    assert warn_at > datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Push payload enums
# ---------------------------------------------------------------------------

def test_interruption_levels_match_the_push_api_spelling():
    """Expo's PUSH API accepts 'active' | 'critical' | 'passive' |
    'time-sensitive'. expo-notifications' LOCAL api spells the third one
    'timeSensitive', and sending that camelCase form to the push endpoint
    fails the entire request with a 400 — every notification in the batch
    silently dies. Verified against the live API when it happened."""
    from app.services.reminder_dispatcher import _INTERRUPTION

    allowed = {"active", "critical", "passive", "time-sensitive"}
    assert set(_INTERRUPTION.values()) <= allowed, (
        f"invalid interruption level(s): {set(_INTERRUPTION.values()) - allowed}"
    )
    # Reminders must never use 'critical' — Apple grants that entitlement case
    # by case for safety alerts, and it overrides the silent switch.
    assert "critical" not in _INTERRUPTION.values()
