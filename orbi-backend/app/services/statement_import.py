"""Import transactions from a statement file the user exported themselves.

WHY THIS EXISTS ALONGSIDE bank_sync
Reading an account through an API needs a licensed AISP and an aggregator
contract. Reading a file the user downloaded from their own bank needs
nothing: they already have the data, they are handing it over deliberately,
and no third party is involved. It is the only route to real transactions
that a solo project can ship today, and for most banks it is a few taps —
Revolut, CGD, Millennium, Novo Banco and Wise all export CSV.

The trade is freshness. A sync is daily and automatic; an import is whenever
the user remembers. That is a real downside and worth saying out loud rather
than pretending the two are equivalent.

COLUMN DETECTION RATHER THAN A FORMAT PER BANK
Every bank names its columns differently and several change them without
warning, so a parser per bank is a maintenance treadmill that breaks quietly.
Instead the header is matched against alias sets: anything that looks like a
date, a description, an amount. Unknown columns are ignored. A file that
matches nothing fails loudly with the headers it actually saw, which is the
one piece of information needed to add an alias.

IDEMPOTENCY
external_id is a hash of date, amount and description, so importing an
overlapping statement — the same month twice, or a fresh export that repeats
last week — writes each transaction exactly once. This is the same guarantee
the daily sync relies on, through the same unique index, which is why
re-importing is safe rather than something the user has to be careful about.
"""

import csv
import hashlib
import io
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime

logger = logging.getLogger(__name__)

# Header aliases, lowercased and stripped of punctuation before matching.
# Ordered by preference: a file with both "completed date" and "started date"
# should use the completed one, because that is when the money actually moved.
_DATE_COLUMNS = (
    "completed date",
    "date completed",
    "transaction date",
    "booking date",
    "date",
    "data",  # pt
    "data valor",
    "data movimento",
    "started date",
)

_DESCRIPTION_COLUMNS = (
    "description",
    "descricao",
    "descrição",
    "details",
    "reference",
    "merchant",
    "payee",
    "name",
    "narrative",
    "descritivo",
)

# Single signed column. Checked before the debit/credit pair below, because a
# file with both should trust the signed one.
_AMOUNT_COLUMNS = (
    "amount",
    "valor",
    "montante",
    "value",
)

_DEBIT_COLUMNS = ("debit", "paid out", "withdrawal", "debito", "débito")
_CREDIT_COLUMNS = ("credit", "paid in", "deposit", "credito", "crédito")

_CURRENCY_COLUMNS = ("currency", "moeda", "ccy")

# Rows in these states have not moved money yet. Importing them shows
# spending that may never happen and, worse, may be imported AGAIN once it
# settles with a different amount.
_PENDING_STATES = {"pending", "reverted", "declined", "failed", "cancelled", "canceled"}
_STATE_COLUMNS = ("state", "status", "estado")

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%d/%m/%Y",
    "%d-%m-%Y",
    "%m/%d/%Y",
    "%d.%m.%Y",
    "%d/%m/%y",
)

MAX_ROWS = 5000


@dataclass(frozen=True)
class ImportedRow:
    external_id: str
    booked_on: date
    # Signed: negative is money leaving, matching BankTransaction so both
    # paths converge on one shape before anything is written.
    amount: float
    currency: str
    description: str


@dataclass
class ImportReport:
    parsed: int = 0
    skipped_pending: int = 0
    skipped_unparseable: int = 0
    rows: list[ImportedRow] | None = None

    def __post_init__(self):
        if self.rows is None:
            self.rows = []


class StatementFormatError(Exception):
    """The file could not be understood. Carries what was actually seen."""


def _normalise_header(value: str) -> str:
    """Lowercase, strip punctuation and collapse spaces, so "Completed Date",
    "completed_date" and "COMPLETED-DATE" are one thing."""
    cleaned = re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()
    return re.sub(r"\s+", " ", cleaned)


def _pick(headers: list[str], candidates: tuple[str, ...]) -> str | None:
    """First header matching any candidate, preferring an exact match.

    Exact before substring so a file with both "date" and "completed date"
    resolves to whichever the candidate list ranks first, rather than to
    whichever happens to appear leftmost.
    """
    normalised = {_normalise_header(h): h for h in headers}
    for candidate in candidates:
        if candidate in normalised:
            return normalised[candidate]
    for candidate in candidates:
        for norm, original in normalised.items():
            if candidate in norm:
                return original
    return None


def _parse_date(value: str) -> date | None:
    raw = (value or "").strip()
    if not raw:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw[: len(fmt) + 6], fmt).date()
        except ValueError:
            continue
    # Last resort: ISO-ish prefix, which covers timestamps with timezones.
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _parse_amount(value: str) -> float | None:
    """Parse an amount written in any of the conventions banks actually use.

    Handles "1.234,56" (European), "1,234.56" (Anglo), a trailing minus
    ("12,50-"), and parenthesised negatives ("(12.50)"). Getting this wrong
    does not error — it silently files a €1,234.56 payment as €1.23 — so each
    case is handled explicitly rather than hoping float() copes.
    """
    raw = (value or "").strip()
    if not raw:
        return None

    negative = False
    if raw.startswith("(") and raw.endswith(")"):
        negative = True
        raw = raw[1:-1]
    if raw.endswith("-"):
        negative = True
        raw = raw[:-1]

    raw = re.sub(r"[^\d,.\-]", "", raw).strip()
    if not raw:
        return None

    if "," in raw and "." in raw:
        # Whichever separator is rightmost is the decimal one.
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        # A lone comma is decimal when it splits off two digits, otherwise
        # it is a thousands separator: "1,50" vs "1,500".
        before, _, after = raw.rpartition(",")
        raw = f"{before}.{after}" if len(after) == 2 else raw.replace(",", "")

    try:
        amount = float(raw)
    except ValueError:
        return None
    return -abs(amount) if negative else amount


def _make_external_id(
    account_id: str, booked_on: date, amount: float, description: str
) -> str:
    """Deterministic id, so re-importing an overlapping statement is a no-op.

    Deliberately excludes any running-balance column: the same transaction
    exported twice can carry different balances if earlier rows were amended,
    and including it would make a duplicate look new.
    """
    digest = hashlib.sha1(
        f"{booked_on.isoformat()}|{amount:.2f}|{description.strip().lower()}".encode()
    ).hexdigest()[:20]
    return f"import:{account_id}:{digest}"


def parse_statement(content: str, *, account_id: str) -> ImportReport:
    """Parse CSV text into transactions. Raises StatementFormatError if it can't."""
    if not content or not content.strip():
        raise StatementFormatError("The file is empty.")

    # Sniff the delimiter — Portuguese banks commonly export semicolon-
    # separated CSV, which the default parser reads as one giant column.
    sample = content[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = ";" if sample.count(";") > sample.count(",") else ","

    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
    headers = [h for h in (reader.fieldnames or []) if h]
    if not headers:
        raise StatementFormatError("No column headers found in the file.")

    date_col = _pick(headers, _DATE_COLUMNS)
    desc_col = _pick(headers, _DESCRIPTION_COLUMNS)
    amount_col = _pick(headers, _AMOUNT_COLUMNS)
    debit_col = _pick(headers, _DEBIT_COLUMNS)
    credit_col = _pick(headers, _CREDIT_COLUMNS)
    currency_col = _pick(headers, _CURRENCY_COLUMNS)
    state_col = _pick(headers, _STATE_COLUMNS)

    if not date_col or (not amount_col and not (debit_col or credit_col)):
        raise StatementFormatError(
            "Could not find a date and an amount column. Saw: "
            + ", ".join(headers[:12])
        )

    report = ImportReport()
    for index, row in enumerate(reader):
        if index >= MAX_ROWS:
            logger.warning("Statement truncated at %s rows", MAX_ROWS)
            break

        if state_col:
            state = _normalise_header(row.get(state_col) or "")
            if state in _PENDING_STATES:
                report.skipped_pending += 1
                continue

        booked_on = _parse_date(row.get(date_col) or "")
        if booked_on is None:
            report.skipped_unparseable += 1
            continue

        if amount_col:
            amount = _parse_amount(row.get(amount_col) or "")
        else:
            debit = _parse_amount(row.get(debit_col) or "") if debit_col else None
            credit = _parse_amount(row.get(credit_col) or "") if credit_col else None
            # A debit column holds a positive number meaning money out, so it
            # has to be negated to reach the signed convention used elsewhere.
            amount = -abs(debit) if debit else (abs(credit) if credit else None)

        if amount is None or amount == 0:
            report.skipped_unparseable += 1
            continue

        description = (row.get(desc_col) or "").strip() if desc_col else ""
        if not description:
            description = "Transaction"

        currency = (row.get(currency_col) or "").strip().upper() if currency_col else ""

        report.rows.append(
            ImportedRow(
                external_id=_make_external_id(account_id, booked_on, amount, description),
                booked_on=booked_on,
                amount=amount,
                currency=currency or "EUR",
                description=description[:500],
            )
        )
        report.parsed += 1

    if not report.rows and report.parsed == 0:
        raise StatementFormatError(
            "No usable transactions found. Checked "
            f"{report.skipped_unparseable + report.skipped_pending} rows."
        )
    return report
