"""Tests for not importing the same week of transactions over and over.

This is a regression suite. Bankinter issues a NEW entry_reference on every
fetch — the transaction number is stable, the token after it is not:

    969TAB190033105998   sync 1
    969TAB040033136388   sync 2   same transaction
    969TAB190033146634   sync 3

Because each copy genuinely had a new id, the unique index on external_id
could not help, and three syncs turned four transactions into twelve rows.
The account balance was wrong by the total of everything imported twice.
"""

from app.services.bank_sync import natural_key, unstored_indices


def key(date: str, amount: float, description: str) -> str:
    return natural_key(entry_date=date, amount=amount, description=description)


# ---------------------------------------------------------------------------
# What counts as the same transaction
# ---------------------------------------------------------------------------

def test_identity_ignores_the_provider_reference():
    """The bug in one line: two reads of the same transaction differ only in
    a token the bank regenerates, so identity cannot include it."""
    first = key("2026-09-21", 10.00, "COMPRA 8430968 Revolut  6563")
    second = key("2026-09-21", 10.00, "COMPRA 8430968 Revolut  6563")
    assert first == second


def test_whitespace_and_case_do_not_create_a_new_transaction():
    """Banks are inconsistent about both between responses."""
    assert key("2026-09-21", 10.0, "COMPRA   8430968  REVOLUT") == key(
        "2026-09-21", 10.0, "compra 8430968 revolut"
    )


def test_a_different_amount_is_a_different_transaction():
    assert key("2026-09-21", 10.00, "Revolut") != key("2026-09-21", 15.00, "Revolut")


def test_a_different_day_is_a_different_transaction():
    assert key("2026-09-21", 10.00, "Revolut") != key("2026-09-20", 10.00, "Revolut")


def test_amounts_compare_at_two_decimals():
    """Providers vary between 2.7 and 2.70 for the same figure."""
    assert key("2026-09-15", 2.7, "TVM") == key("2026-09-15", 2.70, "TVM")


# ---------------------------------------------------------------------------
# How many should exist
# ---------------------------------------------------------------------------

def test_nothing_stored_means_everything_is_new():
    keys = [key("2026-09-21", 10.0, "a"), key("2026-09-21", 15.0, "b")]
    assert unstored_indices(keys, {}) == [0, 1]


def test_a_re_import_writes_nothing():
    """The actual failure: the same window fetched again."""
    keys = [key("2026-09-21", 10.0, "a"), key("2026-09-21", 15.0, "b")]
    stored = {keys[0]: 1, keys[1]: 1}
    assert unstored_indices(keys, stored) == []


def test_genuine_repeats_are_all_kept():
    """Three parking payments of 2.70 at the same machine on the same day are
    three real transactions sharing one key. Membership-based dedup would
    have kept one and thrown away two — losing real money from the ledger,
    which is the failure mode worse than the one being fixed."""
    k = key("2026-09-15", 2.70, "CASCAIS PAR TVM")
    assert unstored_indices([k, k, k], {}) == [0, 1, 2]


def test_only_the_surplus_is_written():
    """Two already stored, three now reported: exactly one is new."""
    k = key("2026-09-15", 2.70, "CASCAIS PAR TVM")
    assert unstored_indices([k, k, k], {k: 2}) == [2]


def test_more_stored_than_reported_writes_nothing():
    """A shrinking window must never produce inserts."""
    k = key("2026-09-15", 2.70, "TVM")
    assert unstored_indices([k], {k: 3}) == []


def test_a_new_transaction_among_known_ones_is_found():
    """The everyday case: yesterday's rows are known, today's is not."""
    old = key("2026-09-20", 10.0, "Revolut")
    new = key("2026-09-21", 4.50, "Padaria")
    assert unstored_indices([old, new], {old: 1}) == [1]


def test_the_decision_does_not_mutate_what_it_was_given():
    """It is called with a dict the caller still uses afterwards."""
    k = key("2026-09-15", 2.70, "TVM")
    stored = {k: 2}
    unstored_indices([k, k, k], stored)
    assert stored == {k: 2}
