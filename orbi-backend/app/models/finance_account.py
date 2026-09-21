from datetime import date, datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class Cadence(str, Enum):
    weekly = "weekly"
    monthly = "monthly"
    yearly = "yearly"


class ConnectionStatus(str, Enum):
    pending = "pending"
    active = "active"
    # The bank approved access but returned several accounts and none
    # matched on IBAN. Not an error: the consent is live and the only thing
    # missing is which of them the user meant.
    choose = "choose"
    expired = "expired"
    revoked = "revoked"
    error = "error"


class FinanceAccount(BaseModel):
    id: UUID
    owner_id: UUID
    name: str
    # Display label and the key imported transactions are matched on. NOT a
    # credential — see migration 0012 and services/bank_providers.py.
    iban: Optional[str] = None
    currency: str = "EUR"
    is_primary: bool = False
    visible: bool = True
    include_in_total: bool = True
    position: int = 0
    opening_balance: float = 0.0
    created_at: datetime


class FinanceAccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    iban: Optional[str] = Field(default=None, max_length=42)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    is_primary: bool = False
    visible: bool = True
    include_in_total: bool = True
    opening_balance: float = 0.0


class FinanceAccountUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    iban: Optional[str] = Field(default=None, max_length=42)
    is_primary: Optional[bool] = None
    visible: Optional[bool] = None
    include_in_total: Optional[bool] = None
    position: Optional[int] = None
    opening_balance: Optional[float] = None
    # Currency is deliberately absent. Changing it after entries exist would
    # silently reinterpret every stored amount.


class AccountBalance(BaseModel):
    """An account plus what is actually in it.

    Balance is derived (opening_balance + entries), never stored: a stored
    running total drifts the first time an entry is edited or deleted, and
    nothing about the row reveals that it has.
    """

    account: FinanceAccount
    balance: float
    entry_count: int


class RecurringTransaction(BaseModel):
    id: UUID
    owner_id: UUID
    account_id: Optional[UUID] = None
    merchant: str
    category: str
    amount: float
    currency: str = "EUR"
    entry_type: str
    notes: Optional[str] = None
    cadence: Cadence
    interval_count: int = 1
    next_run_on: date
    last_run_on: Optional[date] = None
    end_on: Optional[date] = None
    active: bool = True


class RecurringCreate(BaseModel):
    account_id: Optional[UUID] = None
    merchant: str = Field(min_length=1, max_length=120)
    category: str
    amount: float = Field(gt=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    entry_type: str = "expense"
    notes: Optional[str] = None
    cadence: Cadence = Cadence.monthly
    interval_count: int = Field(default=1, ge=1, le=24)
    # The first date this should produce an entry. Defaults are the caller's
    # problem — a rule with no start date has no meaning.
    next_run_on: date
    end_on: Optional[date] = None


class RecurringUpdate(BaseModel):
    account_id: Optional[UUID] = None
    merchant: Optional[str] = Field(default=None, min_length=1, max_length=120)
    category: Optional[str] = None
    amount: Optional[float] = Field(default=None, gt=0)
    entry_type: Optional[str] = None
    notes: Optional[str] = None
    cadence: Optional[Cadence] = None
    interval_count: Optional[int] = Field(default=None, ge=1, le=24)
    next_run_on: Optional[date] = None
    end_on: Optional[date] = None
    active: Optional[bool] = None


class BankConnection(BaseModel):
    """A consented link to one bank account.

    No token or secret is exposed here. `consent_reference` is an opaque
    provider handle; the credential it refers to lives in the provider's
    system, not in this API's responses.
    """

    id: UUID
    owner_id: UUID
    account_id: UUID
    provider: str
    institution_id: Optional[str] = None
    status: ConnectionStatus
    consent_expires_at: Optional[datetime] = None
    last_synced_at: Optional[datetime] = None
    next_sync_after: Optional[datetime] = None
    last_error: Optional[str] = None
    # Present only while status is "choose". Masked identification, never
    # balances or scheme internals — just enough for a human to recognise
    # which of their accounts this is.
    approved_accounts: Optional[list[dict]] = None


class SyncResult(BaseModel):
    considered: int
    imported: int
    failed: int


class FinanceJobResult(BaseModel):
    """What a manual run of the daily finance jobs did."""

    recurring_rules: int
    recurring_entries: int
    sync: SyncResult
    # True when every connection was synced too recently to ask again. The
    # client says "already up to date" rather than "0 imported", which reads
    # as a failure.
    throttled: bool = False


class ConnectResponse(BaseModel):
    """Result of starting a bank connection.

    `authorization_url` is present whenever the provider needs the user to go
    to their own bank and approve access — which is every real provider. It
    is absent only for the sandbox, which speaks to no bank.
    """

    connection: BankConnection
    authorization_url: Optional[str] = None
    message: str


class StatementImportRequest(BaseModel):
    """Raw CSV text from a statement the user exported from their own bank."""

    # Sent as text rather than a multipart upload: the client reads the file
    # it picked, and a JSON body keeps the auth and error handling identical
    # to every other endpoint. Capped so a mis-picked video cannot be parsed
    # as a spreadsheet.
    content: str = Field(min_length=1, max_length=2_000_000)


class ImportResult(BaseModel):
    """What an import actually did, broken down so a low number is explainable."""

    parsed: int
    imported: int
    # Already present. Expected and good on a re-import, not a failure.
    duplicates: int
    # Not settled yet — importing these would show spending that may never
    # happen, and would import again at a different amount once it does.
    skipped_pending: int
    skipped_unreadable: int
