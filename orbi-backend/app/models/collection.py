"""Pydantic schemas for collections: resources, units, routines, payments."""

from datetime import date, time
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

Frequency = Literal["daily", "weekly", "monthly", "yearly"]
OnMiss = Literal["stay_overdue", "skip_ahead", "from_done"]
Direction = Literal["income", "expense"]
Method = Literal["mbway", "transfer", "cash", "card", "other"]
# Which month a payment is FOR: the month it falls due, or the one before
# (rent paid in arrears). Labels only — see migration 0029.
Covers = Literal["due_month", "previous_month"]


class CollectionSettings(BaseModel):
    """Turn a cluster into a collection, and name what it holds."""

    is_collection: bool = True
    collection_noun: Optional[str] = Field(default=None, min_length=1, max_length=24)


class ResourceCreate(BaseModel):
    cluster_id: UUID
    # Set to create a unit inside a resource ("Quarto 3" in "Casa 1").
    parent_id: Optional[UUID] = None
    name: str = Field(min_length=1, max_length=60)
    subtitle: Optional[str] = Field(default=None, max_length=80)
    person_name: Optional[str] = Field(default=None, max_length=60)
    since_on: Optional[date] = None


class ResourceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    subtitle: Optional[str] = Field(default=None, max_length=80)
    person_name: Optional[str] = Field(default=None, max_length=60)
    since_on: Optional[date] = None
    position: Optional[int] = None


class RoutineCreate(BaseModel):
    resource_id: UUID
    title: str = Field(min_length=1, max_length=60)
    kind: Literal["check", "amount"]
    amount: Optional[Decimal] = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    direction: Direction = "income"
    frequency: Frequency
    interval_count: int = Field(default=1, ge=1, le=24)
    anchor_on: date
    due_time: time = time(9, 0)
    on_miss: OnMiss = "stay_overdue"
    remind_before_days: Optional[int] = Field(default=None, ge=1, le=14)
    remind_on_day: bool = True
    remind_after_days: Optional[int] = Field(default=None, ge=1, le=7)
    log_to_finance: bool = False
    finance_category: Optional[str] = Field(default=None, max_length=40)
    covers: Covers = "due_month"

    @model_validator(mode="after")
    def _amount_matches_kind(self) -> "RoutineCreate":
        # The same rule the table enforces, checked here so the user gets a
        # clear message instead of a constraint name.
        if self.kind == "amount" and self.amount is None:
            raise ValueError("An amount routine needs an amount.")
        if self.kind == "check":
            self.amount = None
        return self


class RoutineUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=60)
    amount: Optional[Decimal] = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    direction: Optional[Direction] = None
    frequency: Optional[Frequency] = None
    interval_count: Optional[int] = Field(default=None, ge=1, le=24)
    anchor_on: Optional[date] = None
    due_time: Optional[time] = None
    on_miss: Optional[OnMiss] = None
    remind_before_days: Optional[int] = Field(default=None, ge=1, le=14)
    remind_on_day: Optional[bool] = None
    remind_after_days: Optional[int] = Field(default=None, ge=1, le=7)
    log_to_finance: Optional[bool] = None
    finance_category: Optional[str] = Field(default=None, max_length=40)
    covers: Optional[Covers] = None


class PaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    paid_on: Optional[date] = None
    method: Optional[Method] = None


class SettleRequest(BaseModel):
    """Mark a period finished: pays what is left, or ticks it done."""

    method: Optional[Method] = None
