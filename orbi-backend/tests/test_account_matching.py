"""Tests for matching a bank's approved accounts to an Orbi account.

This is where a real failure happened: Bankinter approved access, returned
several accounts, and the callback threw the whole authorisation away with a
message telling the user to add an IBAN they had already added.

Two rules are being protected. Never guess — filing someone's transactions
against the wrong account is worse than filing none. And never discard a
completed consent — it cost the user a trip through their bank.
"""

from app.routers.finance_accounts import (
    _account_iban,
    _account_uid,
    _choosable_accounts,
    _match_account,
)


def account(iban: str | None = "PT50000201231234567890154") -> dict:
    return {"id": "a1", "name": "Bankinter", "iban": iban}


# ---------------------------------------------------------------------------
# Finding the IBAN whatever shape the bank returned it in
# ---------------------------------------------------------------------------

def test_iban_nested_under_account_id():
    assert _account_iban({"account_id": {"iban": "PT50 0002 0123"}}) == "PT5000020123"


def test_iban_returned_flat():
    """Not every provider nests it. Checking one place meant a bank that
    answered in a different shape looked like one with no IBAN at all."""
    assert _account_iban({"iban": "pt50 0002 0123"}) == "PT5000020123"


def test_iban_under_other_identification():
    assert (
        _account_iban({"account_id": {"other": {"identification": "PT50000201231"}}})
        == "PT50000201231"
    )


def test_no_iban_anywhere_is_none():
    assert _account_iban({"account_id": {}, "name": "Cartão"}) is None


# ---------------------------------------------------------------------------
# The handle used to fetch transactions
# ---------------------------------------------------------------------------

def test_uid_is_read_from_whichever_key_the_provider_used():
    assert _account_uid({"uid": "u-1"}) == "u-1"
    assert _account_uid({"id": "i-1"}) == "i-1"
    assert _account_uid({"resourceId": "r-1"}) == "r-1"


def test_an_unaddressable_account_is_none_not_empty_string():
    """An account we cannot address is one we cannot sync. Returning "" would
    read as a successful match and activate a connection that fetches
    nothing forever."""
    assert _account_uid({"name": "Current"}) is None


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def test_matches_on_iban_among_several():
    session = {
        "accounts": [
            {"uid": "u-1", "account_id": {"iban": "PT50999999999999999999999"}},
            {"uid": "u-2", "account_id": {"iban": "PT50 0002 0123 1234 5678 9015 4"}},
        ]
    }
    assert _match_account(session, account()) == "u-2"


def test_a_single_approved_account_is_unambiguous_without_an_iban():
    session = {"accounts": [{"uid": "only", "account_id": {}}]}
    assert _match_account(session, account(iban=None)) == "only"


def test_several_accounts_and_no_match_refuses_to_guess():
    """The case that broke. Answering with 'probably the first one' would
    file a stranger's transactions into the wrong account silently."""
    session = {
        "accounts": [
            {"uid": "u-1", "account_id": {"iban": "PT50111111111111111111111"}},
            {"uid": "u-2", "account_id": {"iban": "PT50222222222222222222222"}},
        ]
    }
    assert _match_account(session, account()) is None


def test_no_approved_accounts_is_no_match():
    assert _match_account({"accounts": []}, account()) is None


# ---------------------------------------------------------------------------
# What gets stored for the user to choose between
# ---------------------------------------------------------------------------

def test_choices_carry_enough_to_recognise_the_account():
    choices = _choosable_accounts(
        {
            "accounts": [
                {
                    "uid": "u-1",
                    "name": "Conta Ordenado",
                    "currency": "EUR",
                    "account_id": {"iban": "PT50000201231234567890154"},
                }
            ]
        }
    )
    assert choices[0]["uid"] == "u-1"
    assert choices[0]["name"] == "Conta Ordenado"
    # Masked: the full number adds nothing to "which of these is mine?".
    assert choices[0]["masked_iban"] == "PT50…0154"


def test_choices_never_carry_balances_or_provider_internals():
    """These rows sit in the database until the user picks. Storing the
    provider's whole object would keep balances and scheme internals around
    for no reason."""
    choices = _choosable_accounts(
        {
            "accounts": [
                {
                    "uid": "u-1",
                    "balance": 4210.55,
                    "scheme_name": "IBAN",
                    "account_id": {"iban": "PT50000201231234567890154"},
                }
            ]
        }
    )
    assert set(choices[0]) == {"uid", "masked_iban", "name", "currency"}


def test_an_account_with_no_uid_is_not_offered():
    """It could not be synced even if chosen, so offering it is offering a
    dead end."""
    assert _choosable_accounts({"accounts": [{"name": "Mystery"}]}) == []
