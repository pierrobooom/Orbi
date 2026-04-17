"""Finance router — entries, summaries, and budget endpoints.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.db import finance as finance_db
from app.models.finance import FinanceBudget, FinanceEntry, FinanceEntryCreate
from app.services.finance_categorizer import categorize_merchant

router = APIRouter(prefix="/finance", tags=["finance"])


# ---------------------------------------------------------------------------
# Auth placeholder — shared shape with tasks router, replaced together
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str = Header(...)) -> UUID:
    """Extract user_id from the Authorization header.

    Placeholder — returns a fixed UUID until Supabase JWT verification is
    wired in via app/services/auth.py.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Invalid authorization header.", "error_code": "AUTH_HEADER_INVALID"},
        )
    # TODO: decode and verify Supabase JWT, extract sub claim as user_id
    return UUID("00000000-0000-0000-0000-000000000001")


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

@router.post("/entries", response_model=FinanceEntry, status_code=status.HTTP_201_CREATED)
async def create_entry(
    body: FinanceEntryCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create a finance entry with automatic rule-based categorization.

    The merchant name is matched against known merchant rules before saving.
    If no rule matches, category is set to "uncategorized" — AI inference can
    be triggered separately for unknown merchants.
    """
    # Rule-based categorization runs before any AI call, as per CLAUDE.md
    category = categorize_merchant(body.merchant)

    entry = FinanceEntry(
        id=uuid4(),
        user_id=user_id,
        amount=body.amount,
        currency=body.currency,
        merchant=body.merchant,
        category=category,
        entry_type=body.entry_type,
        entry_date=body.entry_date,
        source_type=body.source_type,
        linked_bubble_id=body.linked_bubble_id,
        notes=body.notes,
        created_at=datetime.now(timezone.utc),
    )

    row = await finance_db.insert_entry(entry.model_dump(mode="json"))
    return row


@router.get("/entries", response_model=list[FinanceEntry])
async def list_entries(
    user_id: UUID = Depends(get_current_user),
    category: str | None = Query(default=None, description="Filter by category, e.g. groceries"),
    month: str | None = Query(default=None, description="Filter by month in YYYY-MM format, e.g. 2026-04"),
):
    """List finance entries for the authenticated user.

    Supports optional filtering by category and/or month. Both filters can be
    combined to get, for example, all dining entries in April 2026.
    """
    if month and len(month) != 7:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("month must be in YYYY-MM format.", "INVALID_MONTH_FORMAT"),
        )

    rows = await finance_db.fetch_entries_for_user(user_id, category=category, month=month)
    return rows


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

@router.get("/summary")
async def get_summary(
    user_id: UUID = Depends(get_current_user),
    month: str | None = Query(default=None, description="Month to summarise in YYYY-MM format. Defaults to current month."),
):
    """Return spending and income totals grouped by category for a given month.

    Response shape:
        {
            "month": "2026-04",
            "totals": { "groceries": 145.50, "dining": 88.00, ... },
            "total_spend": 1240.00,
            "total_income": 2500.00
        }
    """
    if month is None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")

    if len(month) != 7:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("month must be in YYYY-MM format.", "INVALID_MONTH_FORMAT"),
        )

    rows = await finance_db.fetch_entries_for_user(user_id, month=month)

    totals: dict[str, float] = defaultdict(float)
    total_spend = 0.0
    total_income = 0.0

    for row in rows:
        amount = float(row["amount"])
        if row["entry_type"] == "income":
            total_income += amount
        else:
            total_spend += amount
            totals[row["category"]] += amount

    return {
        "month": month,
        "totals": dict(totals),
        "total_spend": round(total_spend, 2),
        "total_income": round(total_income, 2),
    }


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------

@router.get("/budgets", response_model=list[FinanceBudget])
async def list_budgets(user_id: UUID = Depends(get_current_user)):
    """Return all budget envelopes for the authenticated user."""
    rows = await finance_db.fetch_budgets_for_user(user_id)
    return rows


@router.post("/budgets", response_model=FinanceBudget, status_code=status.HTTP_200_OK)
async def upsert_budget(
    body: FinanceBudget,
    user_id: UUID = Depends(get_current_user),
):
    """Create or update a budget envelope for a category.

    If a budget for the given category already exists it is updated in place,
    so clients can call this endpoint idempotently without first checking
    whether a budget exists.
    """
    payload = body.model_dump(mode="json")
    # Always enforce ownership from the token
    payload["user_id"] = str(user_id)

    row = await finance_db.upsert_budget(payload)
    return row
