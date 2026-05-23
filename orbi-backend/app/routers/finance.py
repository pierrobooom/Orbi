"""Finance router — entries, summaries, and budget endpoints.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.agents.finance_agent import categorize_unknown_merchant
from app.db import finance as finance_db
from app.models.finance import FinanceBudget, FinanceEntry, FinanceEntryCreate, FinanceEntryUpdate
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.finance_categorizer import categorize_merchant

router = APIRouter(prefix="/finance", tags=["finance"])


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

@router.post("/entries", response_model=FinanceEntry, status_code=status.HTTP_201_CREATED)
async def create_entry(
    body: FinanceEntryCreate,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Create a finance entry with automatic categorization.

    The merchant name is first matched against known merchant rules. If no
    rule matches, the finance agent attempts AI-based categorization as a
    fallback (only for pro and premium tiers — free tier stays uncategorized).
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    # Rule-based categorization runs before any AI call, as per CLAUDE.md
    category = categorize_merchant(body.merchant)

    # AI fallback for unknown merchants (pro and premium only)
    if category == "uncategorized" and user_tier in ("pro", "premium"):
        ai_result = await categorize_unknown_merchant(body.merchant, user_id, user_tier)
        if ai_result.get("confidence", 0) >= 0.5:
            category = ai_result["category"]

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


@router.patch("/entries/{entry_id}", response_model=FinanceEntry)
async def update_entry(
    entry_id: UUID,
    body: FinanceEntryUpdate,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Partial update of a finance entry the user owns.

    If the merchant changes, re-runs the rule-based categoriser (with
    AI fallback for Pro/Genius) so the row stays correctly classified.
    The client can still override by passing `category` explicitly.
    """
    user_id = auth["user_id"]
    user_tier = auth["tier"]

    existing = await finance_db.fetch_entry_by_id(entry_id, user_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Entry not found.", "ENTRY_NOT_FOUND"),
        )

    payload = body.model_dump(exclude_none=True, mode="json")
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("No fields to update.", "NO_UPDATABLE_FIELDS"),
        )

    # If merchant changed and the caller didn't supply a category,
    # re-derive category server-side so the row never drifts out of
    # sync with the rule table.
    if "merchant" in payload and "category" not in payload:
        new_category = categorize_merchant(payload["merchant"])
        if new_category == "uncategorized" and user_tier in ("pro", "premium"):
            ai_result = await categorize_unknown_merchant(payload["merchant"], user_id, user_tier)
            if ai_result.get("confidence", 0) >= 0.5:
                new_category = ai_result["category"]
        payload["category"] = new_category

    row = await finance_db.update_entry(entry_id, user_id, payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Entry not found.", "ENTRY_NOT_FOUND"),
        )
    return row


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: UUID,
    user_id: UUID = Depends(get_current_user),
):
    """Hard-delete a finance entry the user owns.

    Hard delete (not soft) because misclicked or duplicated entries
    are common enough that keeping archived rows would clutter the
    table without benefit.
    """
    success = await finance_db.delete_entry(entry_id, user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Entry not found.", "ENTRY_NOT_FOUND"),
        )


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
