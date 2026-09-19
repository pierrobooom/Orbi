"""Tests for statement (CSV) import.

Parsing is pure, so every bank's idea of a CSV can be pinned without a file
picker, a network, or a database. The cases here are the ones that silently
corrupt data rather than erroring: a European decimal comma read as a
thousands separator turns €1.234,56 into €1.23, and nothing downstream will
ever notice.
"""

from datetime import date

import pytest

from app.services.statement_import import (
    StatementFormatError,
    _parse_amount,
    _parse_date,
    parse_statement,
)

ACCOUNT = "cccccccc-cccc-cccc-cccc-cccccccccccc"

# The real shape Revolut exports.
REVOLUT_CSV = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-09-03 20:51:12,2026-09-03 20:51:14,Chatgpt,-7.99,0.00,EUR,COMPLETED,7.84
TOPUP,Current,2026-09-19 11:33:00,2026-09-19 11:33:05,Money added via *9683,10.00,0.00,EUR,COMPLETED,17.84
TRANSFER,Current,2026-09-19 11:33:10,2026-09-19 11:33:12,To Lucas Cassiano,-5.00,0.00,EUR,COMPLETED,12.84
CARD_PAYMENT,Current,2026-09-18 09:00:00,,Pingo Doce,-12.40,0.00,EUR,PENDING,
"""


def test_revolut_export_parses():
    report = parse_statement(REVOLUT_CSV, account_id=ACCOUNT)
    assert report.parsed == 3
    # The pending card payment has not moved money yet. Importing it would
    # show spending that may never happen — and would import again, at a
    # possibly different amount, once it settles.
    assert report.skipped_pending == 1


def test_completed_date_is_preferred_over_started_date():
    """Both columns exist in a Revolut export; the money moved on the
    completed one."""
    report = parse_statement(REVOLUT_CSV, account_id=ACCOUNT)
    assert report.rows[0].booked_on == date(2026, 9, 3)


def test_signs_are_preserved():
    report = parse_statement(REVOLUT_CSV, account_id=ACCOUNT)
    by_description = {r.description: r.amount for r in report.rows}
    assert by_description["Chatgpt"] == -7.99
    assert by_description["Money added via *9683"] == 10.00


def test_reimporting_the_same_file_produces_the_same_ids():
    """The idempotency guarantee. Exporting an overlapping month again must
    not double anyone's spending."""
    first = parse_statement(REVOLUT_CSV, account_id=ACCOUNT)
    second = parse_statement(REVOLUT_CSV, account_id=ACCOUNT)
    assert [r.external_id for r in first.rows] == [r.external_id for r in second.rows]


def test_ids_differ_per_account():
    """The same transaction imported to two accounts is two transactions."""
    a = parse_statement(REVOLUT_CSV, account_id="aaaa")
    b = parse_statement(REVOLUT_CSV, account_id="bbbb")
    assert a.rows[0].external_id != b.rows[0].external_id


# ---------------------------------------------------------------------------
# Amounts — the failures that corrupt rather than error
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("12.50", 12.50),
        ("-7.99", -7.99),
        ("1,50", 1.50),           # European decimal comma
        ("1.234,56", 1234.56),    # European thousands + decimal
        ("1,234.56", 1234.56),    # Anglo thousands + decimal
        ("1,500", 1500.0),        # lone comma as thousands
        ("12,50-", -12.50),       # trailing minus
        ("(12.50)", -12.50),      # parenthesised negative
        ("€ 12,50", 12.50),
        ("", None),
        ("abc", None),
    ],
)
def test_amount_conventions(raw, expected):
    assert _parse_amount(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-09-03", date(2026, 9, 3)),
        ("2026-09-03 20:51:12", date(2026, 9, 3)),
        ("03/09/2026", date(2026, 9, 3)),
        ("03-09-2026", date(2026, 9, 3)),
        ("03.09.2026", date(2026, 9, 3)),
        ("nonsense", None),
        ("", None),
    ],
)
def test_date_formats(raw, expected):
    assert _parse_date(raw) == expected


# ---------------------------------------------------------------------------
# Other banks' shapes
# ---------------------------------------------------------------------------

def test_semicolon_separated_portuguese_export():
    """Portuguese banks commonly export semicolon-separated CSV, which a
    comma parser reads as one giant column."""
    csv_text = (
        "Data movimento;Descricao;Valor;Moeda\n"
        "19/09/2026;COMPRA CONTINENTE;-12,40;EUR\n"
        "18/09/2026;TRANSFERENCIA;250,00;EUR\n"
    )
    report = parse_statement(csv_text, account_id=ACCOUNT)
    assert report.parsed == 2
    assert report.rows[0].amount == -12.40
    assert report.rows[1].amount == 250.00


def test_separate_debit_and_credit_columns():
    """Many UK banks use a pair of unsigned columns instead of one signed
    one, so the debit side has to be negated."""
    csv_text = (
        "Date,Description,Paid out,Paid in\n"
        "03/09/2026,TESCO STORES,12.40,\n"
        "04/09/2026,SALARY,,1800.00\n"
    )
    report = parse_statement(csv_text, account_id=ACCOUNT)
    assert report.rows[0].amount == -12.40
    assert report.rows[1].amount == 1800.00


def test_headers_are_matched_regardless_of_punctuation_and_case():
    csv_text = "TRANSACTION_DATE,DESCRIPTION,AMOUNT\n2026-09-03,Netflix,-9.99\n"
    report = parse_statement(csv_text, account_id=ACCOUNT)
    assert report.parsed == 1


# ---------------------------------------------------------------------------
# Failing usefully
# ---------------------------------------------------------------------------

def test_unrecognised_file_names_the_headers_it_saw():
    """"Invalid file" sends the user back to guess. The headers are the one
    piece of information needed to add an alias."""
    with pytest.raises(StatementFormatError) as exc:
        parse_statement("Foo,Bar,Baz\n1,2,3\n", account_id=ACCOUNT)
    assert "Foo" in str(exc.value)


def test_empty_file_is_rejected():
    with pytest.raises(StatementFormatError):
        parse_statement("   ", account_id=ACCOUNT)


def test_rows_without_a_usable_date_are_counted_not_crashed_on():
    csv_text = (
        "Date,Description,Amount\n"
        "2026-09-03,Good row,-1.00\n"
        "not-a-date,Bad row,-2.00\n"
    )
    report = parse_statement(csv_text, account_id=ACCOUNT)
    assert report.parsed == 1
    assert report.skipped_unparseable == 1


def test_zero_amount_rows_are_skipped():
    """Balance-carry and fee-reversal lines net to nothing and are noise."""
    csv_text = "Date,Description,Amount\n2026-09-03,Adjustment,0.00\n"
    with pytest.raises(StatementFormatError):
        parse_statement(csv_text, account_id=ACCOUNT)
