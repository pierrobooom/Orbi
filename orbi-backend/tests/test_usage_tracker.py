"""Tests for the per-tier quota tracker.

The DB layer (`app.db.usage`) is fully mocked so these tests run without a
live Supabase. We assert the policy logic: cap lookup, period formatting,
allowed/denied transitions, race-safe rollback, and the QuotaExceeded message.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from app.services import usage_tracker
from app.services.usage_tracker import (
    QuotaExceeded,
    _period_key,
    cap_for,
    check_and_record,
)
from app.services.ai_router import _GROQ_MODEL_LARGE, _GROQ_MODEL_SMALL, _resolve_provider


# ---------------------------------------------------------------------------
# cap_for
# ---------------------------------------------------------------------------

class TestCapFor:
    def test_spark_ai_turn(self):
        assert cap_for("free", "ai_turn") == 30

    def test_pro_ai_turn(self):
        assert cap_for("pro", "ai_turn") == 200

    def test_genius_ai_turn(self):
        assert cap_for("premium", "ai_turn") == 500

    def test_spark_tts_is_30_second_preview(self):
        assert cap_for("free", "tts_seconds") == 30

    def test_pro_tts_is_30_minutes(self):
        assert cap_for("pro", "tts_seconds") == 30 * 60

    def test_genius_tts_is_60_minutes(self):
        assert cap_for("premium", "tts_seconds") == 60 * 60

    def test_spark_stt_is_5_minutes(self):
        assert cap_for("free", "stt_seconds") == 5 * 60

    def test_claude_disabled_for_free_and_pro(self):
        assert cap_for("free", "claude_call") == 0
        assert cap_for("pro", "claude_call") == 0

    def test_claude_genius_monthly_cap_is_100(self):
        assert cap_for("premium", "claude_call") == 100

    def test_unknown_tier_falls_back_to_free(self):
        # Defensive: a malformed profile must never accidentally grant a
        # higher cap than free.
        assert cap_for("nonsense", "ai_turn") == 30

    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError):
            cap_for("pro", "nonsense_kind")


# ---------------------------------------------------------------------------
# _period_key
# ---------------------------------------------------------------------------

class TestPeriodKey:
    def test_daily_kind_uses_iso_date(self):
        now = datetime(2026, 5, 9, 14, 0, tzinfo=timezone.utc)
        assert _period_key("ai_turn", now=now) == "2026-05-09"
        assert _period_key("stt_seconds", now=now) == "2026-05-09"
        assert _period_key("tts_seconds", now=now) == "2026-05-09"

    def test_monthly_kind_uses_year_month(self):
        now = datetime(2026, 5, 9, 14, 0, tzinfo=timezone.utc)
        assert _period_key("claude_call", now=now) == "2026-05"

    def test_day_rolls_over_at_midnight_utc(self):
        before = datetime(2026, 5, 9, 23, 59, 59, tzinfo=timezone.utc)
        after = datetime(2026, 5, 10, 0, 0, 0, tzinfo=timezone.utc)
        assert _period_key("ai_turn", now=before) != _period_key("ai_turn", now=after)

    def test_month_rolls_over_at_first_of_month_utc(self):
        before = datetime(2026, 5, 31, 23, 59, 59, tzinfo=timezone.utc)
        after = datetime(2026, 6, 1, 0, 0, 0, tzinfo=timezone.utc)
        assert _period_key("claude_call", now=before) != _period_key("claude_call", now=after)


# ---------------------------------------------------------------------------
# check_and_record
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_db():
    """Patch the usage_db module so each test starts with an empty store."""
    store: dict[tuple, int] = {}

    async def fake_fetch(user_id, kind, period_key):
        return store.get((str(user_id), kind, period_key), 0)

    async def fake_increment(user_id, kind, period_key, amount):
        key = (str(user_id), kind, period_key)
        store[key] = store.get(key, 0) + amount
        return store[key]

    with patch.object(usage_tracker.usage_db, "fetch_counter", side_effect=fake_fetch), \
         patch.object(usage_tracker.usage_db, "increment_counter", side_effect=fake_increment):
        yield store


@pytest.mark.asyncio
class TestCheckAndRecord:
    async def test_under_cap_allowed_and_returns_total(self, fake_db):
        user = uuid4()
        total = await check_and_record(user, "free", "ai_turn")
        assert total == 1

    async def test_repeated_increments_accumulate(self, fake_db):
        user = uuid4()
        for expected in range(1, 6):
            total = await check_and_record(user, "free", "ai_turn")
            assert total == expected

    async def test_at_cap_blocks_next_call(self, fake_db):
        user = uuid4()
        # Spark ai_turn cap is 30 — fill it.
        for _ in range(30):
            await check_and_record(user, "free", "ai_turn")
        with pytest.raises(QuotaExceeded):
            await check_and_record(user, "free", "ai_turn")

    async def test_blocked_call_does_not_increment(self, fake_db):
        user = uuid4()
        for _ in range(30):
            await check_and_record(user, "free", "ai_turn")
        with pytest.raises(QuotaExceeded):
            await check_and_record(user, "free", "ai_turn")
        # Counter still at 30 — denial must not leave a half-recorded usage.
        period = _period_key("ai_turn")
        assert fake_db[(str(user), "ai_turn", period)] == 30

    async def test_zero_cap_always_blocks(self, fake_db):
        # Free/Pro have claude_call cap = 0. Even the first call must be denied.
        user = uuid4()
        with pytest.raises(QuotaExceeded):
            await check_and_record(user, "free", "claude_call")
        with pytest.raises(QuotaExceeded):
            await check_and_record(user, "pro", "claude_call")

    async def test_genius_claude_monthly_cap(self, fake_db):
        user = uuid4()
        for _ in range(100):
            await check_and_record(user, "premium", "claude_call")
        with pytest.raises(QuotaExceeded):
            await check_and_record(user, "premium", "claude_call")

    async def test_independent_counters_do_not_cross(self, fake_db):
        # Burning ai_turn must not affect tts_seconds and vice versa.
        user = uuid4()
        for _ in range(30):
            await check_and_record(user, "free", "ai_turn")
        # ai_turn is exhausted but tts_seconds is fresh — Spark gets 30s preview.
        total = await check_and_record(user, "free", "tts_seconds", amount=10)
        assert total == 10

    async def test_multi_unit_amount_for_audio_seconds(self, fake_db):
        # STT and TTS are billed in seconds, not single calls.
        user = uuid4()
        await check_and_record(user, "pro", "stt_seconds", amount=120)
        with pytest.raises(QuotaExceeded):
            # Pro cap is 30 min = 1800 sec. 120 + 1700 = 1820 > 1800.
            await check_and_record(user, "pro", "stt_seconds", amount=1700)

    async def test_quota_exceeded_message_names_tier_and_reset(self, fake_db):
        user = uuid4()
        with pytest.raises(QuotaExceeded) as exc_info:
            await check_and_record(user, "free", "claude_call")
        msg = str(exc_info.value)
        # Must use the marketing name and the reset window.
        assert "Spark" in msg
        assert "next month" in msg.lower()


# ---------------------------------------------------------------------------
# ai_router._resolve_provider
# ---------------------------------------------------------------------------
# These don't hit the DB or the network — pure mapping logic.

class TestResolveProvider:
    def test_spark_always_uses_small_model(self):
        for intent in ("daily_chat", "debrief", "weekly_review", "monthly_synthesis"):
            provider, model = _resolve_provider("free", intent)
            assert provider == "groq"
            assert model == _GROQ_MODEL_SMALL

    def test_pro_always_uses_large_model(self):
        for intent in ("daily_chat", "debrief", "weekly_review", "monthly_synthesis"):
            provider, model = _resolve_provider("pro", intent)
            assert provider == "groq"
            assert model == _GROQ_MODEL_LARGE

    def test_genius_daily_chat_uses_large_model_not_claude(self):
        provider, model = _resolve_provider("premium", "daily_chat")
        assert provider == "groq"
        assert model == _GROQ_MODEL_LARGE

    def test_genius_debrief_uses_claude(self):
        provider, model = _resolve_provider("premium", "debrief")
        assert provider == "anthropic"
        assert "claude" in model

    def test_genius_weekly_review_uses_claude(self):
        provider, model = _resolve_provider("premium", "weekly_review")
        assert provider == "anthropic"

    def test_genius_monthly_synthesis_uses_claude(self):
        provider, model = _resolve_provider("premium", "monthly_synthesis")
        assert provider == "anthropic"

    def test_genius_unknown_intent_does_not_reach_claude(self):
        # Defensive: any intent not explicitly listed must route to Llama,
        # never Claude. This protects the monthly Claude budget from typos.
        provider, _ = _resolve_provider("premium", "made_up_intent")
        assert provider == "groq"
