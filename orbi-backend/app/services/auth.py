"""Supabase JWT authentication middleware.

Verifies the JWT from the Authorization header against the project's JWKS,
extracts the user_id (sub claim), and provides it as a FastAPI dependency.

Supabase ships new projects with ES256-signed JWTs and an asymmetric JWKS
endpoint at /auth/v1/.well-known/jwks.json. Public keys are identified by
`kid`; private keys never leave Supabase. We cache keys in-process and
refetch the JWKS whenever a token references a kid we don't recognize,
which transparently handles key rotation.
"""

import logging
import os
from uuid import UUID

import httpx
from fastapi import Header, HTTPException, status
from jose import jwk, jwt
from jose.exceptions import JWTError

logger = logging.getLogger(__name__)

_SUPABASE_URL: str = os.environ.get("SUPABASE_URL", "").rstrip("/")
_JWT_AUDIENCE = "authenticated"
# Only ES256 is accepted. Trusting the alg claim from the token header is the
# classic JWT confusion attack — we pin the algorithm server-side instead.
_JWT_ALGORITHMS = ["ES256"]

# Cache of {kid: jose.jwk.Key}. Populated lazily on first verification and
# refreshed whenever a token references a kid we haven't seen.
_jwks_cache: dict[str, "jwk.Key"] = {}


async def _refresh_jwks() -> None:
    """Fetch the latest JWKS from Supabase and rebuild the cache."""
    if not _SUPABASE_URL:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Auth service is not configured (SUPABASE_URL missing).",
                "error_code": "AUTH_NOT_CONFIGURED",
            },
        )
    url = f"{_SUPABASE_URL}/auth/v1/.well-known/jwks.json"
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        jwks = resp.json()
    new_cache: dict[str, "jwk.Key"] = {}
    for k in jwks.get("keys", []):
        kid = k.get("kid")
        if not kid:
            continue
        new_cache[kid] = jwk.construct(k)
    _jwks_cache.clear()
    _jwks_cache.update(new_cache)


async def _key_for_kid(kid: str) -> "jwk.Key":
    """Return the JWK matching `kid`. Refresh the cache once on a miss."""
    if kid in _jwks_cache:
        return _jwks_cache[kid]
    await _refresh_jwks()
    if kid not in _jwks_cache:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Unknown signing key.",
                "error_code": "AUTH_UNKNOWN_KID",
            },
        )
    return _jwks_cache[kid]


async def _decode_token(token: str) -> dict:
    """Decode and verify a Supabase JWT.

    Validates expiration, audience, and signature. Returns the full claims
    dict on success, raises HTTPException on any failure.
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        logger.warning("Could not parse JWT header: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid token.",
                "error_code": "AUTH_TOKEN_INVALID",
            },
        )

    kid = header.get("kid")
    if not kid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Token missing kid header.",
                "error_code": "AUTH_NO_KID",
            },
        )

    key = await _key_for_kid(kid)

    try:
        payload = jwt.decode(
            token,
            key,
            algorithms=_JWT_ALGORITHMS,
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
    claims = await _decode_token(token)

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
    claims = await _decode_token(token)

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
