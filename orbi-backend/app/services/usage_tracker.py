"""Per-user quota tracking for AI, STT, and TTS calls.

Why this strategy
-----------------
Every paid Orbi tier must hit 50%+ gross margin (CLAUDE.md). That math only
holds if a single heavy user cannot blow past the per-tier ceilings. This
module is the single chokepoint that turns those ceilings into enforced
behaviour — every AI / STT / TTS call passes through `check_and_record()`
before money is spent on a provider.

Three independent counters, one shared mechanism
------------------------------------------------
A single voice exchange can spend three different meters at once:

    speak           -> Deepgram cloud STT       (audio seconds)
    AI replies      -> Groq Llama or Anthropic  (one ai_turn = one round-trip)
    "listen" tap    -> ElevenLabs TTS           (audio seconds, estimated)

Each meter has its own per-tier ceiling in CLAUDE.md, and exhausting one
meter must NOT lock the others. Hitting the daily ai_turn cap should still
let the user listen to a reply they already received, and burning all the
TTS minutes shouldn't prevent further text chat.

So we keep three (four, with claude_call) independent counters but share
the table, the upsert RPC, and the period logic. The cost of a new meter
is one row in TIER_CAPS plus one call site.

Aggregated rows, not append-only
--------------------------------
We keep ONE row per (user, kind, period) and increment in place via the
`increment_ai_usage` Postgres function. An append-only log would balloon
to millions of rows per year (500 turns × users × 365). Aggregated rows
are bounded by user count.

The RPC also closes a race: a read-then-write in Python would let two
concurrent requests both pass the cap check at amount=499 and both
record, leaving the user at 501. `on conflict ... do update` runs as a
single statement under a row lock, so concurrent increments serialise.

UTC-only periods
----------------
Daily counters use 'YYYY-MM-DD' in UTC. Monthly counters (Claude only)
use 'YYYY-MM'. We do NOT use the user's local time zone — billing windows
must be unambiguous, and "midnight UTC" is the message the user sees when
they hit the cap. A user in Tokyo who hits the cap at 09:00 local will be
told it resets at "midnight UTC", which is 09:00 their next morning.
That's an acceptable trade for not having to track per-user time zones
just to enforce a quota.

Internal vs marketing tier names
--------------------------------
DB stores 'free' / 'pro' / 'premium'. Marketing names are Spark / Pro /
Genius. Per CLAUDE.md, the DB values are frozen so existing Phase 1-3 code
keeps working. This module uses the DB names everywhere; only the
user-facing limit-reached message uses the marketing names.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from uuid import UUID

from app.db import usage as usage_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------
# Sourced from CLAUDE.md. Values are per-period totals (daily for ai_turn,
# stt_seconds, tts_seconds; monthly for claude_call). A value of 0 disables
# the meter for that tier (e.g. Claude is fully off for free/pro). None means
# no cap (unused today; reserved for unmetered internal accounts).

# Daily caps
_DAILY_CAPS: dict[str, dict[str, int]] = {
    "free": {  # Spark
        "ai_turn":     30,
        "stt_seconds": 5 * 60,    # 5 minutes
        "tts_seconds": 30,        # 30-second preview
    },
    "pro": {  # Pro
        "ai_turn":     200,
        "stt_seconds": 30 * 60,
        "tts_seconds": 30 * 60,
    },
    "premium": {  # Genius
        "ai_turn":     500,
        "stt_seconds": 60 * 60,
        "tts_seconds": 60 * 60,
    },
}

# Monthly caps. Only Claude is monthly today.
_MONTHLY_CAPS: dict[str, dict[str, int]] = {
    "free":    {"claude_call": 0},
    "pro":     {"claude_call": 0},
    "premium": {"claude_call": 100},
}

_DAILY_KINDS = {"ai_turn", "stt_seconds", "tts_seconds"}
_MONTHLY_KINDS = {"claude_call"}

# Marketing name lookup for user-facing messages only.
_TIER_DISPLAY = {"free": "Spark", "pro": "Pro", "premium": "Genius"}


class QuotaExceeded(Exception):
    """Raised when a usage check would push the user past their tier cap.

    The message is safe to show to the user as-is.
    """

    def __init__(self, kind: str, tier: str, period_label: str):
        self.kind = kind
        self.tier = tier
        self.period_label = period_label
        super().__init__(self._format_message())

    def _format_message(self) -> str:
        display = _TIER_DISPLAY.get(self.tier, self.tier)
        kind_label = {
            "ai_turn":     "daily AI message",
            "stt_seconds": "daily voice transcription",
            "tts_seconds": "daily voice playback",
            "claude_call": "monthly Claude",
        }.get(self.kind, self.kind)
        return (
            f"You've hit your {kind_label} limit on the {display} plan. "
            f"It resets at {self.period_label}."
        )


def _period_key(kind: str, now: datetime | None = None) -> str:
    """Format the period bucket key in UTC.

    Daily kinds use 'YYYY-MM-DD'. Monthly kinds use 'YYYY-MM'. `now` is
    injectable so tests can pin the clock.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if kind in _MONTHLY_KINDS:
        return now.strftime("%Y-%m")
    return now.strftime("%Y-%m-%d")


def _period_reset_label(kind: str) -> str:
    """Human-readable description of when this counter resets."""
    if kind in _MONTHLY_KINDS:
        return "the start of next month (UTC)"
    return "midnight UTC"


def cap_for(tier: str, kind: str) -> int:
    """Return the per-period cap for this tier/kind, or 0 if disabled.

    Unknown tiers default to 'free' so a malformed profile never accidentally
    grants premium quotas. Unknown kinds raise — the call site has a typo.

    In development, all caps are multiplied by 10 so testing flows don't
    burn through the production limits. Production stays at the
    CLAUDE.md-specified values.
    """
    table = _MONTHLY_CAPS if kind in _MONTHLY_KINDS else _DAILY_CAPS
    if kind not in (_DAILY_KINDS | _MONTHLY_KINDS):
        raise ValueError(f"Unknown usage kind: {kind!r}")
    base = table.get(tier, table["free"]).get(kind, 0)
    if base > 0 and os.environ.get("ENVIRONMENT") == "development":
        return base * 10
    return base


async def check_and_record(
    user_id: UUID,
    tier: str,
    kind: str,
    amount: int = 1,
) -> int:
    """Reserve `amount` against the user's quota and return the new total.

    Atomic: the increment runs in a single SQL statement. If the post-increment
    total exceeds the cap, the increment is rolled back logically by a follow-up
    decrement, and QuotaExceeded is raised. Doing it this way (increment then
    check) keeps the hot path one round-trip in the common allowed case at the
    cost of one extra round-trip in the rare denied case.

    Args:
        user_id: Authenticated user.
        tier:    DB tier value — 'free', 'pro', or 'premium'.
        kind:    Counter name — see module docstring.
        amount:  Units to consume. Defaults to 1 (one ai_turn / one claude_call).
                 Pass audio seconds for stt_seconds / tts_seconds.

    Returns:
        The new running total for this period.

    Raises:
        QuotaExceeded: If the cap would be (or has been) exceeded.
    """
    cap = cap_for(tier, kind)
    period = _period_key(kind)

    if cap <= 0:
        # Meter fully disabled for this tier — never call the provider.
        raise QuotaExceeded(kind, tier, _period_reset_label(kind))

    # Cheap pre-check avoids the RPC round-trip when the user is already over.
    current = await usage_db.fetch_counter(user_id, kind, period)
    if current + amount > cap:
        raise QuotaExceeded(kind, tier, _period_reset_label(kind))

    new_total = await usage_db.increment_counter(user_id, kind, period, amount)

    # Race-safe second check: between the pre-check and the increment another
    # request from the same user could have squeezed in. Roll back by
    # decrementing if we tipped over.
    if new_total > cap:
        await usage_db.increment_counter(user_id, kind, period, -amount)
        raise QuotaExceeded(kind, tier, _period_reset_label(kind))

    logger.info(
        "Usage recorded | user=%s kind=%s tier=%s amount=%d total=%d cap=%d period=%s",
        user_id, kind, tier, amount, new_total, cap, period,
    )
    return new_total


# ---------------------------------------------------------------------------
# Read-only usage snapshot for the mobile UI
# ---------------------------------------------------------------------------

def _next_period_resets(now: datetime | None = None) -> tuple[datetime, datetime]:
    """Return (next daily reset, next monthly reset) as UTC datetimes."""
    if now is None:
        now = datetime.now(timezone.utc)
    daily_reset = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    # First day of next month, 00:00 UTC.
    if now.month == 12:
        monthly_reset = now.replace(
            year=now.year + 1, month=1, day=1,
            hour=0, minute=0, second=0, microsecond=0,
        )
    else:
        monthly_reset = now.replace(
            month=now.month + 1, day=1,
            hour=0, minute=0, second=0, microsecond=0,
        )
    return daily_reset, monthly_reset


async def get_user_usage(user_id: UUID, tier: str) -> dict:
    """Snapshot the user's current consumption against every metered kind.

    Used by the mobile UI to show "X / Y turns today" without doing a write.
    Returns a flat shape designed to be serialised straight to JSON.
    """
    daily_reset, monthly_reset = _next_period_resets()
    daily_period = _period_key("ai_turn")  # any daily kind shares the bucket
    monthly_period = _period_key("claude_call")

    daily: dict[str, dict[str, int]] = {}
    for kind in sorted(_DAILY_KINDS):
        used = await usage_db.fetch_counter(user_id, kind, daily_period)
        daily[kind] = {"used": used, "cap": cap_for(tier, kind)}

    monthly: dict[str, dict[str, int]] = {}
    for kind in sorted(_MONTHLY_KINDS):
        used = await usage_db.fetch_counter(user_id, kind, monthly_period)
        monthly[kind] = {"used": used, "cap": cap_for(tier, kind)}

    return {
        "tier": tier,
        "daily": daily,
        "monthly": monthly,
        "resets": {
            "daily": daily_reset.isoformat().replace("+00:00", "Z"),
            "monthly": monthly_reset.isoformat().replace("+00:00", "Z"),
        },
    }
