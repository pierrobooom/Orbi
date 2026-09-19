"""Tests for rule-based merchant categorisation.

The regression that prompted these: matching used to be a plain
`keyword in merchant`, and "tfl" (Transport for London) is a substring of
ne-TFL-ix. Because the transport rules sat above the subscription ones, every
Netflix charge in the database was filed as transport. It was found by feeding
the sandbox bank provider through the importer, which is the whole reason that
provider exists.
"""

import pytest

from app.services.finance_categorizer import categorize_merchant


# ---------------------------------------------------------------------------
# Short keywords must not eat longer merchant names from the inside
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "merchant,expected",
    [
        ("Netflix", "subscriptions"),
        ("NETFLIX.COM AMSTERDAM", "subscriptions"),
        ("Coopers Wine Bar", "uncategorized"),
        ("Applebee's", "uncategorized"),
        ("Pretty Little Thing", "uncategorized"),
    ],
)
def test_substrings_do_not_match_inside_words(merchant, expected):
    assert categorize_merchant(merchant) == expected


def test_the_short_keywords_still_work_on_their_own():
    """Fixing the false positives must not cost the true ones."""
    assert categorize_merchant("TFL TRAVEL CHARGE") == "transport"
    assert categorize_merchant("Co-op Food") == "groceries"
    assert categorize_merchant("BP Connect") == "transport"
    assert categorize_merchant("Apple") == "subscriptions"


def test_keywords_ending_in_punctuation_match():
    """\\b asserts the wrong thing after a "+" or "&", which is why the
    matcher uses lookarounds instead."""
    assert categorize_merchant("Disney+") == "subscriptions"
    assert categorize_merchant("B&Q Warehouse") == "home"


# ---------------------------------------------------------------------------
# Specific rules must beat the general ones they contain
# ---------------------------------------------------------------------------

def test_more_specific_rules_win():
    assert categorize_merchant("Amazon Prime") == "subscriptions"
    assert categorize_merchant("Amazon") == "shopping"
    assert categorize_merchant("Uber Eats") == "dining"
    assert categorize_merchant("Uber") == "transport"


# ---------------------------------------------------------------------------
# Portugal
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "merchant,expected",
    [
        ("Continente", "groceries"),
        ("PINGO DOCE LISBOA", "groceries"),
        ("Mercadona", "groceries"),
        ("Auchan", "groceries"),
        ("GALP ENERGIA", "transport"),
        ("Via Verde", "transport"),
        ("Padaria Central", "dining"),
        ("Pastelaria Suiça", "dining"),
        ("Farmácia Santo António", "health"),
        ("FARMACIA CENTRAL", "health"),
        ("Worten", "home"),
        ("Leroy Merlin", "home"),
        ("MEO", "subscriptions"),
        ("Vodafone", "subscriptions"),
    ],
)
def test_portuguese_merchants(merchant, expected):
    """The table was entirely UK, so the most ordinary transaction in the
    market the app is being tested in fell through to an AI call."""
    assert categorize_merchant(merchant) == expected


def test_accented_and_unaccented_spellings_both_match():
    """Bank feeds strip accents unpredictably; both spellings are real."""
    assert categorize_merchant("Farmácia") == "health"
    assert categorize_merchant("Farmacia") == "health"
    assert categorize_merchant("Minipreço") == "groceries"
    assert categorize_merchant("Minipreco") == "groceries"


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------

def test_unknown_merchant_falls_through_for_the_ai_to_handle():
    assert categorize_merchant("Zzyzx Consulting Ltd") == "uncategorized"


def test_empty_input_is_not_a_crash():
    assert categorize_merchant("") == "uncategorized"
    assert categorize_merchant("   ") == "uncategorized"


def test_matching_is_case_insensitive():
    assert categorize_merchant("tesco") == categorize_merchant("TESCO") == "groceries"
