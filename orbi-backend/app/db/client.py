import logging
import os

from supabase import Client, create_client

logger = logging.getLogger(__name__)

_client: Client | None = None


def get_client() -> Client:
    """Return the shared Supabase client, creating it on first call.

    Lazy initialisation lets the server start without valid credentials so
    /health is reachable even before .env is filled in. The first actual DB
    call will raise a clear error if credentials are missing or invalid.

    Uses the service key so all DB operations bypass Row Level Security.
    Never expose this client or its key to the mobile client.
    """
    global _client
    if _client is None:
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_KEY", "")

        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env "
                "before any database call can be made."
            )

        _client = create_client(url, key)

    return _client


async def test_connection() -> bool:
    """Ping Supabase to verify the connection is alive.

    Returns True if reachable, False otherwise. Intended for use in the
    /health endpoint and startup diagnostics — never in the hot path.
    """
    try:
        get_client().table("user_profiles").select("id").limit(1).execute()
        return True
    except Exception as exc:
        logger.error("Supabase connection check failed: %s", exc)
        return False
