"""Who is allowed to connect a bank account, and how many.

WHY THIS IS NOT JUST A TIER CHECK
Bank data is the one feature in Orbi billed per connected account per month,
and the aggregator's invoice has a monthly minimum underneath it. That makes
two separate questions:

    Is the feature switched on at all?   — a business decision about the bill
    Is this user entitled to it?         — a subscription decision

They are deliberately separate flags. The feature stays off until there are
enough paying subscribers to clear the monthly floor, and until then even a
Genius subscriber sees "coming soon" rather than a button that would start
an invoice. Conflating the two would mean the only way to delay the cost was
to pretend nobody had paid.

WHY THERE IS AN ALLOWLIST
Development and support need a live connection against a real bank while the
feature is off for everyone else. Without it, testing the thing would mean
enabling the bill.

THE CAPS
Per connected account per month is the unit, so the cap is on accounts, not
on users. Someone with six accounts costs three times someone with two, on
the same subscription.
"""

import os
from uuid import UUID

# Tier → how many bank accounts may be connected at once.
#
# Free is absent rather than zero as a reminder that the free tier is not a
# crippled paid tier: it gets statement import and manual entry, which need
# no licence, no aggregator and no monthly minimum.
ACCOUNT_LIMITS: dict[str, int] = {
    "pro": 2,
    "premium": 5,
}

PAID_TIERS = frozenset(ACCOUNT_LIMITS)


class SyncGate:
    """Why a user can or cannot connect a bank, in a form the UI can render."""

    def __init__(self, allowed: bool, reason: str, limit: int = 0) -> None:
        self.allowed = allowed
        # 'ok' | 'coming_soon' | 'upgrade' | 'limit' | 'no_provider'
        self.reason = reason
        self.limit = limit


def feature_enabled() -> bool:
    """Is automatic bank sync switched on for ordinary users?

    Defaults to off. A feature that spends money per user per month should
    never arrive by accident because an environment variable was forgotten.
    """
    return os.environ.get("BANK_SYNC_ENABLED", "0").strip() in {"1", "true", "yes"}


def _allowlisted(user_id: UUID) -> bool:
    raw = os.environ.get("BANK_SYNC_ALLOWLIST", "")
    ids = {item.strip() for item in raw.split(",") if item.strip()}
    return str(user_id) in ids


def check_bank_sync(
    user_id: UUID,
    tier: str,
    *,
    connected_accounts: int = 0,
    provider_configured: bool = True,
) -> SyncGate:
    """Decide whether this user may connect another bank account.

    Order matters. The provider check comes first because without one there
    is nothing to connect to regardless of tier, and offering an upgrade to
    reach a feature that does not exist on this deployment is worse than
    saying so.
    """
    if not provider_configured:
        return SyncGate(False, "no_provider")

    # Dev and support: a real connection while the feature is off for
    # everyone else.
    if _allowlisted(user_id):
        return SyncGate(True, "ok", limit=ACCOUNT_LIMITS.get(tier, 99))

    if not feature_enabled():
        return SyncGate(False, "coming_soon")

    limit = ACCOUNT_LIMITS.get(tier, 0)
    if limit == 0:
        return SyncGate(False, "upgrade")

    if connected_accounts >= limit:
        return SyncGate(False, "limit", limit=limit)

    return SyncGate(True, "ok", limit=limit)
