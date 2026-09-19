"""Finance accounts, recurring rules, and bank connections.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from app.db import finance as finance_db, finance_accounts as accounts_db
from app.models.finance_account import (
    AccountBalance,
    BankConnection,
    FinanceAccount,
    FinanceAccountCreate,
    FinanceAccountUpdate,
    FinanceJobResult,
    RecurringCreate,
    RecurringTransaction,
    RecurringUpdate,
    SyncResult,
)
from app.services import finance_scheduler
from app.services.auth import get_current_user
from app.services.bank_providers import configured_provider_name
from app.services.bank_sync import connections_needing_attention

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/finance", tags=["finance"])


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# ---------------------------------------------------------------------------
# Accounts
#
# Declared before any /{id} route for the same reason the cluster router does:
# FastAPI matches in registration order, and a static path registered later is
# swallowed by an earlier parameterised one.
# ---------------------------------------------------------------------------

@router.get("/accounts", response_model=list[AccountBalance])
async def list_accounts(user_id: UUID = Depends(get_current_user)):
    """Return the user's accounts, each with its derived balance.

    Balances are computed here rather than stored. A running total kept on the
    row drifts the first time an entry is edited or deleted, and nothing about
    the row shows that it has — so the only honest balance is one derived from
    the entries every time it is asked for.
    """
    accounts = await accounts_db.list_accounts(user_id)
    if not accounts:
        return []

    entries = await finance_db.fetch_entries_for_user(user_id)

    totals: dict[str, float] = {}
    counts: dict[str, int] = {}
    for entry in entries:
        account_id = str(entry.get("account_id") or "")
        if not account_id:
            continue
        amount = float(entry.get("amount") or 0)
        signed = -amount if entry.get("entry_type") == "expense" else amount
        totals[account_id] = totals.get(account_id, 0.0) + signed
        counts[account_id] = counts.get(account_id, 0) + 1

    return [
        AccountBalance(
            account=FinanceAccount(**account),
            balance=round(
                float(account.get("opening_balance") or 0)
                + totals.get(str(account["id"]), 0.0),
                2,
            ),
            entry_count=counts.get(str(account["id"]), 0),
        )
        for account in accounts
    ]


@router.post(
    "/accounts", response_model=FinanceAccount, status_code=status.HTTP_201_CREATED
)
async def create_account(
    body: FinanceAccountCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create an account.

    The first account a user creates becomes primary whether they asked or
    not — otherwise every new entry has no default and the receipt-capture
    path has nowhere to file anything.
    """
    existing = await accounts_db.list_accounts(user_id)
    make_primary = body.is_primary or not existing

    if make_primary:
        await accounts_db.clear_primary(user_id)

    iban = accounts_db.normalise_iban(body.iban)
    if iban:
        clash = await accounts_db.find_account_by_iban(user_id, iban)
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_error(
                    f"That IBAN is already on the account \"{clash.get('name')}\".",
                    "IBAN_ALREADY_USED",
                ),
            )

    payload = {
        "id": str(uuid4()),
        "owner_id": str(user_id),
        "name": body.name.strip(),
        "iban": iban,
        "currency": body.currency.upper(),
        "is_primary": make_primary,
        "visible": body.visible,
        "include_in_total": body.include_in_total,
        "position": len(existing),
        "opening_balance": body.opening_balance,
    }
    return await accounts_db.insert_account(payload)


@router.patch("/accounts/{account_id}", response_model=FinanceAccount)
async def update_account(
    account_id: UUID,
    body: FinanceAccountUpdate,
    user_id: UUID = Depends(get_current_user),
):
    """Update an account. Currency is immutable by design."""
    existing = await accounts_db.fetch_account(account_id, user_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Account not found.", "ACCOUNT_NOT_FOUND"),
        )

    payload = body.model_dump(exclude_unset=True, mode="json")
    if "iban" in payload:
        payload["iban"] = accounts_db.normalise_iban(payload["iban"])

    # Demote the incumbent first: the partial unique index rejects a second
    # primary rather than letting one be cleaned up afterwards.
    if payload.get("is_primary"):
        await accounts_db.clear_primary(user_id, except_id=account_id)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("No fields to update.", "NO_UPDATABLE_FIELDS"),
        )

    row = await accounts_db.update_account(account_id, user_id, payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Account not found.", "ACCOUNT_NOT_FOUND"),
        )
    return row


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(account_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Delete an account. Its entries survive, unassigned.

    Deleting an account is a bookkeeping decision; taking a year of spending
    history with it is never what anyone meant.
    """
    if not await accounts_db.delete_account(account_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Account not found.", "ACCOUNT_NOT_FOUND"),
        )


# ---------------------------------------------------------------------------
# Recurring transactions
# ---------------------------------------------------------------------------

@router.get("/recurring", response_model=list[RecurringTransaction])
async def list_recurring(user_id: UUID = Depends(get_current_user)):
    return await accounts_db.list_recurring(user_id)


@router.post(
    "/recurring", response_model=RecurringTransaction, status_code=status.HTTP_201_CREATED
)
async def create_recurring(
    body: RecurringCreate,
    user_id: UUID = Depends(get_current_user),
):
    """Create a recurring rule.

    Nothing is materialised here. The scheduler owns that, so a rule starting
    today produces its first entry on the next tick through exactly the same
    code path as every later one — rather than a special case that only the
    first entry ever exercises.
    """
    payload = body.model_dump(mode="json")
    payload["id"] = str(uuid4())
    payload["owner_id"] = str(user_id)
    payload["currency"] = body.currency.upper()
    return await accounts_db.insert_recurring(payload)


@router.patch("/recurring/{rule_id}", response_model=RecurringTransaction)
async def update_recurring(
    rule_id: UUID,
    body: RecurringUpdate,
    user_id: UUID = Depends(get_current_user),
):
    payload = body.model_dump(exclude_unset=True, mode="json")
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("No fields to update.", "NO_UPDATABLE_FIELDS"),
        )
    row = await accounts_db.update_recurring(rule_id, user_id, payload)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Recurring rule not found.", "RECURRING_NOT_FOUND"),
        )
    return row


@router.delete("/recurring/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring(rule_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Delete a rule. Entries it already produced are left alone.

    Those entries are history — money that actually moved. Cancelling a gym
    membership does not refund the last eight months of it.
    """
    if not await accounts_db.delete_recurring(rule_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Recurring rule not found.", "RECURRING_NOT_FOUND"),
        )


# ---------------------------------------------------------------------------
# Bank connections
# ---------------------------------------------------------------------------

@router.get("/connections", response_model=list[BankConnection])
async def list_connections(user_id: UUID = Depends(get_current_user)):
    """Every bank link this user has, whatever state it is in."""
    return await accounts_db.list_connections(user_id)


@router.get("/connections/attention", response_model=list[BankConnection])
async def connections_attention(user_id: UUID = Depends(get_current_user)):
    """Connections the user has to act on.

    Expired, errored, or expiring within the warning window. Exists because a
    feed that quietly stops is indistinguishable from a quiet month, and the
    user will believe the total long after it stopped being true.
    """
    return await connections_needing_attention(user_id)


@router.get("/provider")
async def provider_status(user_id: UUID = Depends(get_current_user)):
    """Which bank provider this deployment is configured against.

    "manual" means no aggregator is configured and no automatic import will
    happen — reported plainly so the client can say so rather than showing a
    Connect button that leads nowhere.
    """
    name = configured_provider_name()
    return {
        "provider": name,
        "automatic_import": name != "manual",
        "note": (
            "No bank provider configured. Transactions arrive from manual "
            "entry, receipts, and recurring rules."
            if name == "manual"
            else f"Connected accounts sync once per day via {name}."
        ),
    }


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: UUID, user_id: UUID = Depends(get_current_user)
):
    """Disconnect a bank account. Imported entries are kept.

    The entries are a record of money that moved; revoking consent to fetch
    MORE of them says nothing about the ones already recorded.
    """
    if not await accounts_db.delete_connection(connection_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Connection not found.", "CONNECTION_NOT_FOUND"),
        )


@router.post("/run-jobs", response_model=FinanceJobResult)
async def run_jobs(user_id: UUID = Depends(get_current_user)):
    """Run the daily finance jobs now.

    For development and for a "refresh" affordance. It does NOT bypass the
    per-account cooldown: an account synced an hour ago stays invisible to this
    until its day is up, so no amount of tapping refresh can run up a provider
    bill.
    """
    result = await finance_scheduler.run_once(datetime.now(timezone.utc))
    return FinanceJobResult(
        recurring_rules=result["recurring"]["rules"],
        recurring_entries=result["recurring"]["entries"],
        sync=SyncResult(**result["bank_sync"]),
    )
