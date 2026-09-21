"""Finance accounts, recurring rules, and bank connections.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from fastapi.responses import HTMLResponse

from app.db import finance as finance_db, finance_accounts as accounts_db
from app.models.finance_account import (
    AccountBalance,
    BankConnection,
    ConnectResponse,
    FinanceAccount,
    FinanceAccountCreate,
    FinanceAccountUpdate,
    FinanceJobResult,
    ImportResult,
    RecurringCreate,
    RecurringTransaction,
    RecurringUpdate,
    StatementImportRequest,
    SyncResult,
)
from app.services import finance_scheduler
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.bank_providers import (
    ProviderNotConfigured,
    configured_provider_name,
    get_provider,
)
from app.services.bank_sync import connections_needing_attention, sync_user_now
from app.services.finance_categorizer import categorize_merchant
from app.services.finance_dashboard import build_dashboard
from app.services.finance_insights import (
    build_rows,
    deterministic_insights,
    generate_ai_insights,
    should_regenerate,
)
from app.services.statement_import import StatementFormatError, parse_statement

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


class ChooseAccountRequest(BaseModel):
    """Which approved account this Orbi account corresponds to."""

    uid: str = Field(min_length=1, max_length=200)


@router.post("/connections/{connection_id}/choose", response_model=BankConnection)
async def choose_connection_account(
    connection_id: UUID,
    body: ChooseAccountRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Finish a connection whose bank returned several approved accounts.

    The consent already exists — this only records which of the approved
    accounts the user meant, which is the one thing no amount of server-side
    cleverness can determine safely.

    The uid must be one the provider actually returned. Trusting the client
    here would let a typo point a connection at an account the user never
    approved, and the sync would then fail in a way that looks like a
    provider outage rather than a bad request.
    """
    connection = await accounts_db.fetch_connection(connection_id, user_id)
    if connection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Connection not found.", "CONNECTION_NOT_FOUND"),
        )
    if connection.get("status") != "choose":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_error(
                "That connection is not waiting for a choice.", "NOT_CHOOSABLE"
            ),
        )

    approved = connection.get("approved_accounts") or []
    if not any(str(item.get("uid")) == body.uid for item in approved):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_error("That account was not one of the approved ones.", "UNKNOWN_ACCOUNT"),
        )

    updated = await accounts_db.update_connection(
        connection_id,
        {
            "status": "active",
            "external_account_id": body.uid,
            # Stale the moment the choice is made, and it is the provider's
            # data about accounts the user may not have picked.
            "approved_accounts": None,
            "last_error": None,
            "next_sync_after": datetime.now(timezone.utc).isoformat(),
        },
    )
    return updated or connection


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
            else (
                "SANDBOX MODE — transactions are fabricated for testing and are "
                "not from any real account."
                if name == "sandbox"
                else f"Connected accounts sync once per day via {name}."
            )
        ),
    }


@router.get("/callback", response_class=HTMLResponse)
async def bank_callback(code: str | None = None, state: str | None = None,
                        error: str | None = None):
    """Where the user's bank sends them back after approving.

    NOT an authenticated API call. A browser lands here, redirected from the
    bank, so there is no JWT and no `get_current_user` — the only thing tying
    the request to a user is `state`, which begin_connection set to the
    account id. That is safe enough here because the account id is an
    unguessable UUID, the authorisation code is single-use and short-lived,
    and the code is worthless without the application's private key.

    Returns HTML rather than JSON because a human is looking at it. They have
    just been bounced through two apps and need to be told, in words, that it
    worked and they can go back.
    """
    if error:
        logger.warning("Bank callback returned an error: %s", error)
        return HTMLResponse(_callback_page(ok=False, detail=error), status_code=400)
    if not code or not state:
        return HTMLResponse(
            _callback_page(ok=False, detail="Missing code or state."),
            status_code=400,
        )

    try:
        connection = await accounts_db.find_pending_connection_for_account(state)
        if connection is None:
            return HTMLResponse(
                _callback_page(ok=False, detail="No pending connection found."),
                status_code=404,
            )

        provider = get_provider(connection.get("provider"))
        complete = getattr(provider, "complete_connection", None)
        if complete is None:
            return HTMLResponse(
                _callback_page(ok=False, detail="Provider cannot complete a session."),
                status_code=501,
            )

        session = await complete(code=code)
        account = await accounts_db.fetch_account(
            UUID(str(connection["account_id"])), UUID(str(connection["owner_id"]))
        )

        # Authorised, but the provider exposed no accounts at all. Distinct
        # from "several, and we cannot tell which": there is nothing to pick
        # from, so offering a picker shows an empty list under the heading
        # "Which account is this?", which reads as a bug.
        #
        # In restricted mode this is the expected answer for any account not
        # linked in the provider's control panel — the consent succeeds and
        # the accounts are filtered out afterwards. In full production it
        # means the bank shared nothing we can use.
        choices = _choosable_accounts(session)
        if not choices:
            logger.warning(
                "Session %s authorised but exposed no accounts (aspsp=%s)",
                session.get("session_id"),
                (session.get("aspsp") or {}).get("name"),
            )
            await accounts_db.update_connection(
                UUID(str(connection["id"])),
                {
                    "status": "error",
                    "last_error": "The bank approved access but shared no "
                    "accounts. This account may not be available through "
                    "open banking yet.",
                },
            )
            return HTMLResponse(
                _callback_page(
                    ok=False,
                    detail="Your bank approved access but didn't share any "
                    "accounts, so there is nothing to connect yet.",
                ),
                status_code=409,
            )

        external_account_id = _match_account(session, account)
        if not external_account_id:
            # Authorised, but we cannot tell WHICH of the approved accounts is
            # the one they meant. Guessing is not an option — filing someone's
            # transactions against the wrong account is worse than filing none
            # — but neither is throwing the authorisation away, which is what
            # this used to do. The consent is the expensive part: it cost the
            # user a trip through their bank, a login and a biometric prompt.
            #
            # So it is kept, and the app asks. 'choose' is a real state, not
            # an error: the bank said yes and only the mapping is missing.
            await accounts_db.update_connection(
                UUID(str(connection["id"])),
                {
                    "status": "choose",
                    "consent_reference": str(session.get("session_id") or ""),
                    "approved_accounts": choices,
                    "last_error": None,
                },
            )
            return HTMLResponse(
                _callback_page(
                    ok=True,
                    detail="Approved. Go back to Orbi and pick which account "
                    "this is — your bank returned more than one.",
                ),
            )

        await accounts_db.update_connection(
            UUID(str(connection["id"])),
            {
                "status": "active",
                "external_account_id": external_account_id,
                "consent_reference": str(session.get("session_id") or ""),
                # Claimable immediately, so the first sync does not wait a day.
                "next_sync_after": datetime.now(timezone.utc).isoformat(),
                "last_error": None,
            },
        )
        return HTMLResponse(_callback_page(ok=True))

    except Exception as exc:  # noqa: BLE001 — a browser must never see a traceback
        logger.error("Bank callback failed: %s", exc)
        return HTMLResponse(
            _callback_page(ok=False, detail="Something went wrong completing the link."),
            status_code=500,
        )


def _account_uid(candidate: dict) -> str | None:
    """The provider's handle for an approved account.

    Providers disagree about the key — Enable Banking returns `uid`, others
    `id` or `resourceId` — and an account we cannot address is one we cannot
    sync, so it is better to return None than an empty string that looks
    like a successful match.
    """
    for key in ("uid", "id", "resourceId", "resource_id"):
        value = candidate.get(key)
        if value:
            return str(value)
    return None


def _account_iban(candidate: dict) -> str | None:
    """The IBAN of an approved account, wherever this provider put it.

    Banks are inconsistent about the shape: some nest it under account_id,
    some return it flat, some only give `other.identification`. Checking one
    place meant a bank that answered in a different shape looked like a bank
    that had returned no IBAN at all.
    """
    identifiers = candidate.get("account_id") or {}
    for source in (
        identifiers.get("iban"),
        candidate.get("iban"),
        (identifiers.get("other") or {}).get("identification"),
        (candidate.get("other") or {}).get("identification"),
    ):
        normalised = accounts_db.normalise_iban(source)
        if normalised:
            return normalised
    return None


def _match_account(session: dict, account: dict | None) -> str | None:
    """Pick which approved account corresponds to the user's Orbi account.

    By IBAN first — this is the one job the IBAN field genuinely does, and
    the payoff for having asked for it. When only one account was approved,
    that is unambiguous regardless. Otherwise nothing is guessed: the user
    is asked, via the 'choose' state.
    """
    approved = session.get("accounts") or []
    if not approved:
        return None

    stored_iban = accounts_db.normalise_iban((account or {}).get("iban"))
    if stored_iban:
        for candidate in approved:
            if _account_iban(candidate) == stored_iban:
                return _account_uid(candidate)

    if len(approved) == 1:
        return _account_uid(approved[0])
    return None


def _choosable_accounts(session: dict) -> list[dict]:
    """Approved accounts, reduced to what a human needs to pick between.

    Deliberately not the provider's raw objects: those carry balances,
    scheme names and internal ids that have no business being stored longer
    than the choice takes. What is kept is a handle to select with and
    enough identification to recognise the account — masked, because the
    full IBAN adds nothing to "which of these is my current account?".
    """
    out: list[dict] = []
    for candidate in session.get("accounts") or []:
        uid = _account_uid(candidate)
        if not uid:
            continue
        iban = _account_iban(candidate)
        out.append(
            {
                "uid": uid,
                "masked_iban": (f"{iban[:4]}…{iban[-4:]}" if iban and len(iban) > 8 else iban),
                "name": (
                    candidate.get("name")
                    or candidate.get("product")
                    or (candidate.get("account_id") or {}).get("name")
                ),
                "currency": candidate.get("currency"),
            }
        )
    return out

    return None


def _callback_page(*, ok: bool, detail: str = "") -> str:
    """A plain page for a human who has just been bounced between two apps."""
    title = "Account connected" if ok else "Couldn't connect"
    # A successful outcome can still have something specific to say — an
    # approval that needs the user to pick which account it was, for
    # instance. Without this, detail was silently dropped whenever ok.
    body = detail or (
        "Your transactions will start appearing in Orbi shortly. "
        "You can close this page and go back to the app."
        if ok
        else "Please try again from Orbi."
    )
    tint = "#4ade80" if ok else "#ff4d6d"
    return f"""<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;
justify-content:center;background:#0e0e14;color:#f2f2f7;
font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:22rem;padding:2rem;text-align:center">
<div style="font-size:2.5rem;margin-bottom:1rem;color:{tint}">{'&#10003;' if ok else '&#33;'}</div>
<h1 style="font-size:1.25rem;margin:0 0 .75rem">{title}</h1>
<p style="margin:0;color:#9b9ba5">{body}</p>
</div></body></html>"""


@router.post("/accounts/{account_id}/import", response_model=ImportResult)
async def import_statement(
    account_id: UUID,
    body: StatementImportRequest,
    user_id: UUID = Depends(get_current_user),
):
    """Import transactions from a statement the user exported themselves.

    The route to real data that needs no licence and no aggregator: the user
    already has the file, and hands it over deliberately. Revolut, CGD,
    Millennium, Novo Banco and Wise all export CSV in a few taps.

    Safe to run twice. Transaction ids are a hash of date, amount and
    description, so re-importing an overlapping statement writes each one
    once — the same guarantee, through the same unique index, that the daily
    sync relies on.
    """
    account = await accounts_db.fetch_account(account_id, user_id)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Account not found.", "ACCOUNT_NOT_FOUND"),
        )

    try:
        report = parse_statement(body.content, account_id=str(account_id))
    except StatementFormatError as exc:
        # 422 with the reason: "could not find a date column, saw X, Y, Z" is
        # actionable, where a bare "invalid file" sends the user back to guess.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error(str(exc), "STATEMENT_FORMAT"),
        )

    known = await finance_db.existing_external_ids(
        user_id, [r.external_id for r in report.rows]
    )
    fresh = [r for r in report.rows if r.external_id not in known]

    rows = [
        {
            "user_id": str(user_id),
            "account_id": str(account_id),
            "amount": abs(r.amount),
            "currency": r.currency or account.get("currency") or "EUR",
            "merchant": r.description[:200],
            "category": categorize_merchant(r.description),
            "entry_type": "expense" if r.amount < 0 else "income",
            "entry_date": r.booked_on.isoformat(),
            "source_type": "import",
            "external_id": r.external_id,
            "raw_description": r.description,
        }
        for r in fresh
    ]
    written = await finance_db.insert_entries(rows)

    return ImportResult(
        parsed=report.parsed,
        imported=written,
        duplicates=len(report.rows) - len(fresh),
        skipped_pending=report.skipped_pending,
        skipped_unreadable=report.skipped_unparseable,
    )


@router.get("/insights")
async def list_insights(
    refresh: bool = False,
    auth: dict = Depends(get_current_user_with_tier),
):
    """What is worth noticing about this month's spending.

    Two sources, and the order matters. Deterministic rules run on every read
    — they are free, they cannot be wrong, and they are what a free-tier user
    gets. The model adds to that list rather than replacing it, so an outage
    or a rate limit degrades this screen to fewer insights instead of none.

    The AI half runs at most once a day per user, and only for tiers that pay
    for it. `refresh` asks for a regeneration and is still subject to that
    window: a button that spent an AI call per tap would be the largest line
    on the bill.
    """
    user_id = auth["user_id"]
    tier = auth["tier"]
    month = datetime.now(timezone.utc).strftime("%Y-%m")

    entries = await finance_db.fetch_entries_for_user(user_id)
    dashboard = build_dashboard(entries, month)
    limits = (await list_limits(user_id))["limits"]

    stored = await finance_db.fetch_insights(user_id, month)
    ai_eligible = tier in ("pro", "premium")

    generated = False
    if ai_eligible:
        last = await finance_db.latest_insight_time(user_id, month)
        if refresh or should_regenerate(last):
            ai = await generate_ai_insights(dashboard, limits, user_id, tier)
            if ai:
                await finance_db.replace_insights(
                    user_id, month, build_rows(ai, user_id)
                )
                stored = await finance_db.fetch_insights(user_id, month)
                generated = True

    # Computed fresh every time rather than stored: they are cheap, and
    # persisting them would mean a limit changed this morning still showing
    # yesterday's remaining balance.
    rules = deterministic_insights(dashboard, limits)

    return {
        "month": month,
        "insights": rules + list(stored),
        "ai_available": ai_eligible,
        "ai_generated": generated,
        # So the client can explain a short list rather than looking empty.
        "entry_count": dashboard.get("entry_count", 0),
    }


@router.post("/insights/{insight_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss_insight(insight_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Hide an insight the user has read.

    Kept rather than deleted: which observations get dismissed immediately is
    the clearest signal about which are worth generating at all.
    """
    if not await finance_db.dismiss_insight(insight_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Insight not found.", "INSIGHT_NOT_FOUND"),
        )


@router.get("/breakdown")
async def spending_breakdown(
    month: str | None = None,
    user_id: UUID = Depends(get_current_user),
):
    """Every vendor and every category, with what was spent at each.

    The dashboard shows the top few because a summary that lists everything
    is not a summary. This is the other half: the full list, for when the
    question is "how much have I actually spent at X".
    """
    if month is None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")

    entries = [
        e
        for e in await finance_db.fetch_entries_for_user(user_id, month=month)
        if e.get("entry_type") == "expense"
    ]

    vendors: dict[str, dict] = {}
    categories: dict[str, dict] = {}
    for entry in entries:
        amount = float(entry.get("amount") or 0)
        name = (entry.get("merchant") or "").strip() or "Unknown"
        slot = vendors.setdefault(
            name, {"name": name, "amount": 0.0, "count": 0, "category": entry.get("category")}
        )
        slot["amount"] += amount
        slot["count"] += 1

        key = entry.get("category") or "uncategorized"
        cat = categories.setdefault(key, {"category": key, "amount": 0.0, "count": 0})
        cat["amount"] += amount
        cat["count"] += 1

    def _clean(rows):
        for row in rows:
            row["amount"] = round(row["amount"], 2)
        return sorted(rows, key=lambda r: r["amount"], reverse=True)

    return {
        "month": month,
        "vendors": _clean(list(vendors.values())),
        "categories": _clean(list(categories.values())),
        "total": round(sum(float(e.get("amount") or 0) for e in entries), 2),
    }


@router.get("/limits")
async def list_limits(user_id: UUID = Depends(get_current_user)):
    """Spending limits with how much of each has actually been used.

    Spend is summed from entries rather than read from finance_budgets.
    current_spend, which has been on that table since 0001 and is left
    deliberately unused: a stored running total drifts the moment an entry is
    edited or deleted, and nothing about the row admits it. Same reasoning as
    account balances.
    """
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    budgets = await finance_db.fetch_budgets_for_user(user_id)
    entries = await finance_db.fetch_entries_for_user(user_id, month=month)

    spent: dict[str, float] = {}
    for entry in entries:
        if entry.get("entry_type") != "expense":
            continue
        key = entry.get("category") or "uncategorized"
        spent[key] = spent.get(key, 0.0) + float(entry.get("amount") or 0)

    out = []
    for budget in budgets:
        limit = float(budget.get("monthly_limit") or 0)
        used = round(spent.get(budget["category"], 0.0), 2)
        out.append(
            {
                "id": budget["id"],
                "category": budget["category"],
                "monthly_limit": limit,
                "alert_threshold": float(budget.get("alert_threshold") or 0.8),
                "alerts_enabled": bool(budget.get("alerts_enabled", True)),
                "spent": used,
                "remaining": round(limit - used, 2),
                "fraction": round(used / limit, 4) if limit > 0 else None,
            }
        )
    out.sort(key=lambda b: (b["fraction"] is None, -(b["fraction"] or 0)))
    return {"month": month, "limits": out}


class LimitInput(BaseModel):
    """Set a ceiling on a category.

    Deliberately not the full FinanceBudget model. That one requires an id, a
    user_id and a period the client has no business inventing, which forced
    callers to fabricate values the server then overwrote — and a fabricated
    primary key is a real hazard, not just noise.
    """

    category: str = Field(min_length=1, max_length=40)
    monthly_limit: float = Field(gt=0)
    # Where the first warning fires, as a fraction of the limit. Default 80%:
    # early enough that there is still something to decide.
    alert_threshold: float = Field(default=0.8, ge=0.1, le=1.0)
    alerts_enabled: bool = True


@router.put("/limits")
async def set_limit(
    body: LimitInput,
    user_id: UUID = Depends(get_current_user),
):
    """Create or update the ceiling for one category.

    Upserts on (user_id, category), so a client never has to check whether a
    limit already exists before setting one.

    Raising a limit clears the alert state for the month. Otherwise someone
    who was warned at 80% of 200, then decided 300 was the real number, would
    never hear about 80% of 300 — the app would have gone quiet precisely
    because they engaged with it.
    """
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    existing = {
        b["category"]: b for b in await finance_db.fetch_budgets_for_user(user_id)
    }
    previous = existing.get(body.category)

    start = datetime.now(timezone.utc).date().replace(day=1)
    from calendar import monthrange

    end = start.replace(day=monthrange(start.year, start.month)[1])

    payload = {
        "user_id": str(user_id),
        "category": body.category,
        "monthly_limit": body.monthly_limit,
        "alert_threshold": body.alert_threshold,
        "alerts_enabled": body.alerts_enabled,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
    }
    if previous:
        payload["id"] = previous["id"]
        raised = body.monthly_limit > float(previous.get("monthly_limit") or 0)
        if raised:
            payload["notified_level"] = None
            payload["notified_period"] = None
    else:
        payload["id"] = str(uuid4())
        payload["current_spend"] = 0

    return await finance_db.upsert_budget(payload)


@router.delete("/limits/{budget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_limit(budget_id: UUID, user_id: UUID = Depends(get_current_user)):
    """Remove a spending limit. The transactions it watched are untouched."""
    if not await finance_db.delete_budget(budget_id, user_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Limit not found.", "LIMIT_NOT_FOUND"),
        )


@router.get("/dashboard")
async def finance_dashboard(
    month: str | None = None,
    account_id: UUID | None = None,
    user_id: UUID = Depends(get_current_user),
):
    """Spending for one month, against the months before it.

    Every figure is a sum over the user's own rows — no AI. Asking a model to
    total a column costs tokens to do arithmetic and occasionally gets it
    wrong; the AI's job is reading these numbers, not producing them.

    Optionally scoped to one account, because "what did I spend" and "what did
    I spend on this card" are different questions and the tab lets the user
    pick which one they are asking.
    """
    if month is None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
    if len(month) != 7:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error("month must be in YYYY-MM format.", "INVALID_MONTH_FORMAT"),
        )

    # One fetch covering the month AND its comparison window; the service
    # slices it rather than the router issuing a query per month.
    entries = await finance_db.fetch_entries_for_user(user_id)
    if account_id is not None:
        entries = [
            e for e in entries if str(e.get("account_id") or "") == str(account_id)
        ]

    return build_dashboard(entries, month)


@router.get("/institutions")
async def list_institutions(
    country: str = "PT",
    user_id: UUID = Depends(get_current_user),
):
    """Banks the user can connect to, for the picker.

    Users do not all bank in the same place. The institution was originally a
    deployment-wide environment variable, which silently sent everyone to one
    bank — fine for a single-developer test, wrong the moment there is a
    second person.

    Fetched live rather than hardcoded: providers add and remove banks
    continuously, and a stale list offers people an institution they cannot
    actually connect to.
    """
    provider = get_provider(configured_provider_name())
    lister = getattr(provider, "list_institutions", None)
    if lister is None:
        return {"country": country.upper(), "institutions": []}
    try:
        return {"country": country.upper(), "institutions": await lister(country)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not list institutions: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=_error(
                "Could not load the list of banks. Try again shortly.",
                "INSTITUTIONS_UNAVAILABLE",
            ),
        )


class ConnectRequest(BaseModel):
    """Which bank to connect this account to.

    Optional so a single-user deployment can keep relying on the environment
    default, but a multi-user one must always send it.
    """

    institution: Optional[str] = None
    country: Optional[str] = Field(default=None, min_length=2, max_length=2)


@router.post("/accounts/{account_id}/connect", response_model=ConnectResponse)
async def connect_account(
    account_id: UUID,
    body: ConnectRequest | None = None,
    user_id: UUID = Depends(get_current_user),
):
    """Start linking an account to the configured bank provider.

    This is the step that was missing, and its absence is instructive: an
    account and a connection are different things. Typing an IBAN creates an
    ACCOUNT — a label to file transactions against. Syncing iterates
    CONNECTIONS, which only exist once a provider has been asked to link one,
    and for any real provider that means the user going to their own bank and
    approving it.

    For a real provider the response carries an authorization_url and the
    connection sits at 'pending' until the user returns. The sandbox is the
    only one that can come back 'active' immediately, because it speaks to no
    bank at all.
    """
    account = await accounts_db.fetch_account(account_id, user_id)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Account not found.", "ACCOUNT_NOT_FOUND"),
        )

    existing = [
        c
        for c in await accounts_db.list_connections(user_id)
        if str(c.get("account_id")) == str(account_id)
        and c.get("status") in {"pending", "active"}
    ]
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_error(
                "That account is already connected.", "ALREADY_CONNECTED"
            ),
        )

    provider_name = configured_provider_name()
    provider = get_provider(provider_name)
    try:
        draft = await provider.begin_connection(
            account=account,
            institution=(body.institution if body else None),
            country=(body.country if body else None),
        )
    except ProviderNotConfigured as exc:
        # 501 rather than 400: the request was fine, the capability is absent.
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=_error(str(exc), "PROVIDER_NOT_CONFIGURED"),
        )

    payload = {
        "id": str(uuid4()),
        "owner_id": str(user_id),
        "account_id": str(account_id),
        "provider": provider_name,
        "institution_id": draft.institution_id,
        "external_account_id": draft.external_account_id,
        "consent_reference": draft.consent_reference,
        "consent_expires_at": draft.consent_expires_at,
        "status": draft.status,
        # Claimable by the scheduler straight away, so a freshly connected
        # account shows something without waiting a day for the first tick.
        "next_sync_after": datetime.now(timezone.utc).isoformat(),
    }
    connection = await accounts_db.insert_connection(payload)

    return ConnectResponse(
        connection=BankConnection(**connection),
        authorization_url=draft.authorization_url,
        message=(
            "Connected. Transactions will sync once a day."
            if draft.status == "active"
            else "Open the link to sign in with your bank and approve access."
        ),
    )


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
    now = datetime.now(timezone.utc)
    recurring = await finance_scheduler.materialise_recurring(now.date())
    # The USER'S connections, on the manual floor — not the background sweep.
    # Using the daily cadence here made Update a button that did nothing for
    # twenty-two hours after the first sync.
    sync = await sync_user_now(user_id, now)

    return FinanceJobResult(
        recurring_rules=recurring["rules"],
        recurring_entries=recurring["entries"],
        sync=SyncResult(
            considered=sync["considered"],
            imported=sync["imported"],
            failed=sync["failed"],
        ),
        throttled=sync.get("throttled", False),
    )
