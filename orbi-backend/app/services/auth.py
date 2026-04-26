"""Supabase JWT authentication middleware.

Verifies the JWT from the Authorization header against Supabase's JWKS,
extracts the user_id (sub claim), and provides it as a FastAPI dependency.
"""

import logging
import os
from uuid import UUID

from fastapi import Header, HTTPException, status
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

# Supabase JWTs are signed with the project's JWT secret (HS256)
_JWT_SECRET: str = os.environ.get("SUPABASE_JWT_SECRET", "")
_JWT_ALGORITHM = "HS256"
_JWT_AUDIENCE = "authenticated"


def _decode_token(token: str) -> dict:
    """Decode and verify a Supabase JWT.

    Validates expiration, audience, and signature. Returns the full
    claims dict on success, raises HTTPException on any failure.
    """
    if not _JWT_SECRET:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Auth service is not configured.",
                "error_code": "AUTH_NOT_CONFIGURED",
            },
        )

    try:
        payload = jwt.decode(
            token,
            _JWT_SECRET,
            algorithms=[_JWT_ALGORITHM],
            audience=_JWT_AUDIENCE,
        )
        return payload
    except JWTError as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid or expired token.",
                "error_code": "AUTH_TOKEN_INVALID",
            },
        )


async def get_current_user(authorization: str = Header(...)) -> UUID:
    """FastAPI dependency — extract and verify the user_id from the Bearer token.

    Usage in routers:
        from app.services.auth import get_current_user
        @router.get("/things")
        async def list_things(user_id: UUID = Depends(get_current_user)):
            ...
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Authorization header must start with 'Bearer '.",
                "error_code": "AUTH_HEADER_INVALID",
            },
        )

    token = authorization[len("Bearer "):]
    claims = _decode_token(token)

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Token missing subject claim.",
                "error_code": "AUTH_NO_SUBJECT",
            },
        )

    try:
        return UUID(sub)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid user ID in token.",
                "error_code": "AUTH_INVALID_USER_ID",
            },
        )


async def get_current_user_with_tier(authorization: str = Header(...)) -> dict:
    """FastAPI dependency — returns both user_id and subscription tier from the JWT.

    Supabase custom claims include app_metadata with the subscription_tier.
    Falls back to "free" if not present.

    Returns:
        {"user_id": UUID, "tier": str}
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Authorization header must start with 'Bearer '.",
                "error_code": "AUTH_HEADER_INVALID",
            },
        )

    token = authorization[len("Bearer "):]
    claims = _decode_token(token)

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Token missing subject claim.",
                "error_code": "AUTH_NO_SUBJECT",
            },
        )

    try:
        user_id = UUID(sub)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid user ID in token.",
                "error_code": "AUTH_INVALID_USER_ID",
            },
        )

    # Supabase stores custom data in app_metadata
    app_metadata = claims.get("app_metadata", {})
    tier = app_metadata.get("subscription_tier", "free")

    return {"user_id": user_id, "tier": tier}
