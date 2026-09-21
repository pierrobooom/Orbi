"""Tests for turning a bank narrative line into a merchant name.

These strings are real, taken from a Portuguese bank feed where every single
transaction came back uncategorised. The reason was never the rule table: it
was that none of these IS a merchant name, so nothing could ever match.
"""

import pytest

from app.services.finance_categorizer import categorize_merchant
from app.services.merchant_cleanup import clean_merchant, is_transfer


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("COMPRA 8430968 NOS CINEMAS OEIRAS", "NOS Cinemas Oeiras"),
        ("COMPRA 8430968.08 CASCAIS PAR TVM", "Cascais Par TVM"),
        ("COMPRA 8430968 PET CITY", "Pet City"),
        ("COMPRA 8430968 Tasquinha da Mitas", "Tasquinha da Mitas"),
        ("PAGAMENTO SERVICOS 12345 MEO", "MEO"),
        ("Transf Imed de Lucas Pierrobom", "Lucas Pierrobom"),
    ],
)
def test_the_merchant_is_extracted_from_the_narrative(raw, expected):
    assert clean_merchant(raw) == expected


def test_the_card_number_goes_because_it_splits_one_shop_into_many():
    """The digits differ per card, so the same shop paid from two cards was
    two merchants in every per-vendor total."""
    first = clean_merchant("COMPRA 8430968 CONTINENTE")
    second = clean_merchant("COMPRA 9112233.02 CONTINENTE")
    assert first == second == "Continente"


def test_a_trailing_card_fragment_goes_too():
    assert clean_merchant("COMPRA 8430968 Revolut  6563") == "Revolut"


def test_bank_charges_keep_a_readable_label():
    """There is no merchant in a conversion fee, and inventing one files it
    under shopping."""
    assert clean_merchant("TAXA DE CONVERSAO") == "Taxa de Conversão"
    assert clean_merchant("LEVANTAMENTO ATM 4321 LISBOA") == "Levantamento ATM"


def test_brand_acronyms_survive_title_casing():
    """Banks shout. Title-casing "NOS" into "Nos" renames the company."""
    assert clean_merchant("COMPRA 123456 NOS COMUNICACOES") == "NOS Comunicacoes"


def test_particles_stay_lower_case():
    assert clean_merchant("COMPRA 123456 TASQUINHA DA MITAS") == "Tasquinha da Mitas"


def test_an_unrecognised_format_degrades_to_the_bank_s_own_words():
    """Better a line the user can read than an empty merchant."""
    assert clean_merchant("ODD FORMAT HERE") == "Odd Format Here"
    assert clean_merchant("COMPRA 8430968") == "COMPRA 8430968"


def test_a_token_containing_digits_is_left_exactly_as_it_came():
    """Deliberate: "PT50" and "B&Q1" are written the way they are written,
    and case-folding them invents a spelling nobody uses."""
    assert clean_merchant("LOJA PT50 CENTRO") == "Loja PT50 Centro"


def test_empty_input_is_empty_output():
    assert clean_merchant(None) == ""
    assert clean_merchant("   ") == ""


# ---------------------------------------------------------------------------
# Transfers
# ---------------------------------------------------------------------------

def test_a_transfer_is_recognised_from_the_raw_line():
    assert is_transfer("Transf Imed de Lucas Pierrobom")
    assert is_transfer("MB WAY para Ana")
    assert not is_transfer("COMPRA 8430968 CONTINENTE")


def test_moving_your_own_money_is_not_spending():
    """Counting transfers as expenses inflates every total on the dashboard,
    and the inflation is invisible because the rows all look legitimate."""
    raw = "Transf Imed de Lucas Pierrobom"
    assert categorize_merchant(clean_merchant(raw), raw) == "transfers"


def test_the_cleaned_name_alone_would_not_reveal_a_transfer():
    """Which is why the raw line is passed separately: cleaning removes the
    very words that mark it."""
    assert not is_transfer("Lucas Pierrobom")


# ---------------------------------------------------------------------------
# What this was all for
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,category",
    [
        ("COMPRA 123456 CONTINENTE CASCAIS", "groceries"),
        ("COMPRA 123456 Tasquinha da Mitas", "dining"),
        ("COMPRA 123456 NOS CINEMAS OEIRAS", "leisure"),
        ("COMPRA 123456 FARMACIA CENTRAL", "health"),
        ("TAXA DE CONVERSAO", "fees"),
        ("LEVANTAMENTO ATM 1234 LISBOA", "cash"),
    ],
)
def test_cleaning_is_what_makes_categorising_possible(raw, category):
    assert categorize_merchant(clean_merchant(raw), raw) == category


def test_the_same_strings_categorise_as_nothing_without_cleaning():
    """The regression this protects: categorising the raw line fails even
    for merchants the rule table knows perfectly well."""
    assert categorize_merchant("COMPRA 123456 Tasquinha da Mitas") == "dining"
    # ...but the reference number alone is not a merchant at all.
    assert categorize_merchant("COMPRA 8430968") == "uncategorized"
