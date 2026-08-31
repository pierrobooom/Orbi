"""Users router — profile and preference endpoints.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

import logging
from datetime import datetime, time, timezone
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.db import device_tokens as device_tokens_db, users as users_db
from app.models.user import UsageSnapshot, UserPreference, UserProfile
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.locale import get_locale
from app.services.push import send_push
from app.services.usage_tracker import get_user_usage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


def _error(message: str, error_code: str) -> dict:
    """Build a structured error response body."""
    return {"message": message, "error_code": error_code}


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

@router.get("/me", response_model=UserProfile)
async def get_my_profile(user_id: UUID = Depends(get_current_user)):
    """Return the authenticated user's profile."""
    row = await users_db.fetch_profile(user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("User profile not found.", "USER_NOT_FOUND"),
        )
    return row


@router.patch("/me", response_model=UserProfile)
async def update_my_profile(
    body: dict,
    user_id: UUID = Depends(get_current_user),
):
    """Update the authenticated user's profile.

    Only full_name is updatable by the user. Subscription tier is managed
    server-side and cannot be changed through this endpoint.
    """
    allowed_fields = {"full_name"}
    payload = {k: v for k, v in body.items() if k in allowed_fields}

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_error(
                "No updatable fields provided. Allowed: full_name.",
                "NO_UPDATABLE_FIELDS",
            ),
        )

    payload["updated_at"] = datetime.now(timezone.utc).isoformat()

    row = await users_db.update_profile(user_id, payload)
    return row


# ---------------------------------------------------------------------------
# Usage / quota snapshot
# ---------------------------------------------------------------------------

@router.get("/me/usage", response_model=UsageSnapshot)
async def get_my_usage(auth: dict = Depends(get_current_user_with_tier)):
    """Return current quota consumption for every metered kind plus caps.

    Read-only — no writes against the usage table. Used by the mobile UI
    to show e.g. "12 / 30 turns today" without spending an AI call just
    to inspect the meter.
    """
    return await get_user_usage(auth["user_id"], auth["tier"])


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------

@router.get("/me/preferences", response_model=UserPreference)
async def get_my_preferences(user_id: UUID = Depends(get_current_user)):
    """Return the authenticated user's preferences."""
    row = await users_db.fetch_preferences(user_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error(
                "Preferences not found. Set them with PUT /users/me/preferences.",
                "PREFERENCES_NOT_FOUND",
            ),
        )
    return row


class UserPreferenceInput(BaseModel):
    """PUT body for preferences.

    Deliberately has no user_id: the server always takes it from the auth
    token, so requiring it in the body bought nothing and cost a 422 for
    any client that didn't have a preferences row to copy one from — the
    exact situation of a user saving preferences for the first time.

    Every field is optional so a client can send just the one setting it
    is changing; unset fields fall back to the stored row, then to the
    same defaults as the DB columns.
    """

    quiet_hours_start: Optional[time] = None
    quiet_hours_end: Optional[time] = None
    proactivity_level: Optional[int] = Field(default=None, ge=1, le=5)
    preferred_reminder_channel: Optional[str] = None
    language: Optional[str] = None


@router.put("/me/preferences", response_model=UserPreference)
async def set_my_preferences(
    body: UserPreferenceInput,
    user_id: UUID = Depends(get_current_user),
):
    """Create or replace the authenticated user's preferences.

    user_id is always taken from the auth token — the body's user_id field
    is overridden to prevent users from setting preferences for others.
    """
    # Merge over whatever is stored so a partial update doesn't wipe the
    # fields the client didn't send.
    existing = await users_db.fetch_preferences(user_id) or {}
    defaults = {
        "quiet_hours_start": "22:00:00",
        "quiet_hours_end": "08:00:00",
        "proactivity_level": 3,
        "preferred_reminder_channel": "push",
        "language": "en-GB",
    }
    incoming = body.model_dump(mode="json", exclude_none=True)
    payload = {**defaults, **{k: v for k, v in existing.items() if v is not None}, **incoming}
    payload["user_id"] = str(user_id)
    # Coerce rather than reject: an unsupported tag from a stale client
    # falls back to English instead of 500ing on the DB check constraint.
    payload["language"] = get_locale(payload.get("language")).tag
    # Coerce rather than reject: an unsupported tag from a stale client
    # falls back to English instead of 500ing on the DB check constraint.
    payload["language"] = get_locale(payload.get("language")).tag

    row = await users_db.upsert_preferences(payload)
    return row


class DeleteAccountRequest(BaseModel):
    """Confirmation body for account deletion.

    The JWT already proves WHO is asking; typing the email proves the
    request was INTENDED. This is irreversible and cascades across every
    table, so a mis-tapped button must not be enough to trigger it.
    """

    confirm_email: str


@router.post("/me/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    body: DeleteAccountRequest,
    auth: dict = Depends(get_current_user_with_tier),
):
    """Permanently delete the authenticated user and all of their data.

    Apple requires an app that offers account creation to offer in-app
    account deletion, so this is a store-submission blocker, not a
    nicety.

    Deletes the Supabase Auth user; the ON DELETE CASCADE chain removes
    every owned row. Nothing is soft-deleted and nothing is retained —
    that is the point.

    POST rather than DELETE because it takes a confirmation body, and a
    request body on DELETE is poorly supported across proxies and
    clients.
    """
    user_id = auth["user_id"]

    profile = await users_db.fetch_profile(user_id)
    if profile is None:
        # Nothing to delete. Idempotent by design: a client retrying
        # after a dropped response should not get an error.
        return None

    submitted = (body.confirm_email or "").strip().lower()
    actual = str(profile.get("email") or "").strip().lower()
    if not submitted or submitted != actual:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_error(
                "Type your account email exactly to confirm deletion.",
                "DELETE_CONFIRMATION_MISMATCH",
            ),
        )

    try:
        await users_db.delete_auth_user(user_id)
    except Exception as exc:  # noqa: BLE001 — surfaced, not swallowed
        logger.error("Account deletion failed for %s: %s", user_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_error(
                "Could not delete the account. Nothing was removed — try again.",
                "ACCOUNT_DELETE_FAILED",
            ),
        )

    # Deliberately logged: an irreversible, user-initiated destruction is
    # exactly the event you want a record of. No content, just the fact.
    logger.warning("Account deleted | user_id=%s", user_id)
    return None


# ---------------------------------------------------------------------------
# Push notification device tokens
# ---------------------------------------------------------------------------

class DeviceTokenRegister(BaseModel):
    # Expo push token: "ExponentPushToken[...]" (~50 chars). FCM/APNs raw
    # tokens are longer but Expo Go only ever issues the Exponent format.
    token: str = Field(min_length=1, max_length=500)
    platform: Literal["ios", "android", "web"]


class DeviceTokenResponse(BaseModel):
    id: UUID
    user_id: UUID
    token: str
    platform: str
    created_at: datetime
    last_seen_at: datetime


class TestPushResponse(BaseModel):
    sent: int
    tickets: list[dict]


@router.post("/me/device-tokens", response_model=DeviceTokenResponse, status_code=status.HTTP_201_CREATED)
async def register_device_token(
    body: DeviceTokenRegister,
    user_id: UUID = Depends(get_current_user),
):
    """Register or refresh a device's Expo push token for the current user.

    Idempotent — re-registering the same token bumps last_seen_at.
    """
    row = await device_tokens_db.upsert_token(user_id, body.token, body.platform)
    return row


@router.delete("/me/device-tokens/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device_token(
    token: str,
    user_id: UUID = Depends(get_current_user),
):
    """Drop a device token. Called on sign-out from the device that owns it."""
    deleted = await device_tokens_db.delete_token(user_id, token)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error("Device token not found.", "DEVICE_TOKEN_NOT_FOUND"),
        )


@router.post("/me/device-tokens/test", response_model=TestPushResponse)
async def send_test_push(user_id: UUID = Depends(get_current_user)):
    """Fire a smoke-test push to every device registered for this user.

    Useful during dev to prove the registration + Expo Push chain works
    end-to-end without waiting on the reminder scheduler.
    """
    tokens = await device_tokens_db.list_tokens_for_user(user_id)
    if not tokens:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error(
                "No device tokens registered for this user.",
                "NO_DEVICE_TOKENS",
            ),
        )
    tickets = await send_push(
        tokens,
        title="Hello from Orbi",
        body="Push registration is working.",
        data={"kind": "test"},
    )
    return TestPushResponse(sent=len(tokens), tickets=tickets)
