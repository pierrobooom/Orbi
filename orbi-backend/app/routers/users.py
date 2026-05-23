"""Users router — profile and preference endpoints.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.db import device_tokens as device_tokens_db, users as users_db
from app.models.user import UsageSnapshot, UserPreference, UserProfile
from app.services.auth import get_current_user, get_current_user_with_tier
from app.services.push import send_push
from app.services.usage_tracker import get_user_usage

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


@router.put("/me/preferences", response_model=UserPreference)
async def set_my_preferences(
    body: UserPreference,
    user_id: UUID = Depends(get_current_user),
):
    """Create or replace the authenticated user's preferences.

    user_id is always taken from the auth token — the body's user_id field
    is overridden to prevent users from setting preferences for others.
    """
    payload = body.model_dump(mode="json")
    payload["user_id"] = str(user_id)

    row = await users_db.upsert_preferences(payload)
    return row


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
