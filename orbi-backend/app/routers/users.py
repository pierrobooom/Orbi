"""Users router — profile and preference endpoints.

Routers contain no business logic. Each handler extracts inputs, delegates to
a service or db function, and formats the response.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.db import users as users_db
from app.models.user import UserPreference, UserProfile
from app.services.auth import get_current_user

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
