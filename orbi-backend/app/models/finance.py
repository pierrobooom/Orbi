from datetime import date, datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class EntryType(str, Enum):
    income = "income"
    expense = "expense"


class InsightSeverity(str, Enum):
    info = "info"
    warning = "warning"
    alert = "alert"


class FinanceEntry(BaseModel):
    id: UUID
    user_id: UUID
    amount: float
    currency: str = "GBP"
    merchant: str
    category: str
    entry_type: EntryType
    entry_date: date
    # how the entry was created, e.g. "manual", "bank_import", "receipt_scan"
    source_type: str
    linked_bubble_id: Optional[UUID] = None
    notes: Optional[str] = None
    created_at: datetime


class FinanceEntryCreate(BaseModel):
    user_id: UUID
    amount: float
    currency: str = "GBP"
    merchant: str
    category: str
    entry_type: EntryType
    entry_date: date
    source_type: str = "manual"
    linked_bubble_id: Optional[UUID] = None
    notes: Optional[str] = None


class FinanceEntryUpdate(BaseModel):
    """Partial update for an existing entry. All fields optional."""
    amount: Optional[float] = None
    currency: Optional[str] = None
    merchant: Optional[str] = None
    category: Optional[str] = None
    entry_type: Optional[EntryType] = None
    entry_date: Optional[date] = None
    notes: Optional[str] = None


class FinanceBudget(BaseModel):
    id: UUID
    user_id: UUID
    category: str
    monthly_limit: float
    # fraction of monthly_limit at which an alert is triggered (e.g. 0.8 = 80%)
    alert_threshold: float = Field(default=0.8, ge=0.0, le=1.0)
    current_spend: float
    period_start: date
    period_end: date


class FinanceInsight(BaseModel):
    id: UUID
    user_id: UUID
    insight_text: str
    category: str
    severity: InsightSeverity
    created_at: datetime
