-- Orbi AI / voice usage counters (Phase 3.5 — pre-mobile launch)
-- Run after 0001_initial_schema.sql in the Supabase SQL editor.
-- Idempotent: every statement is `if not exists` so re-running is safe.

-- =============================================================================
-- ai_usage_counters
-- =============================================================================
-- One row per (user, kind, period). Aggregated counters keep table size bounded
-- by user count rather than call volume, which matters once a single Genius
-- user can fire ~500 turns/day plus thousands of TTS seconds.
--
-- kind values:
--   ai_turn       -> one chat round-trip (Llama or Claude). Period = day.
--   stt_seconds   -> seconds of audio sent to Deepgram cloud STT. Period = day.
--   tts_seconds   -> seconds of audio synthesised by ElevenLabs (estimated from
--                    text length). Period = day.
--   claude_call   -> separate counter so Genius's monthly Claude cap can be
--                    enforced independently of the daily ai_turn cap. Period = month.
--
-- period_key format:
--   daily   counters: 'YYYY-MM-DD' in UTC
--   monthly counters: 'YYYY-MM'    in UTC
-- The router formats this string before calling the upsert; storing it as text
-- keeps the rollover logic in Python (testable) rather than in SQL.

create table if not exists ai_usage_counters (
    user_id     uuid not null references user_profiles(id) on delete cascade,
    kind        text not null check (kind in ('ai_turn','stt_seconds','tts_seconds','claude_call')),
    period_key  text not null,
    amount      bigint not null default 0,
    updated_at  timestamptz not null default now(),
    primary key (user_id, kind, period_key)
);

-- Lookups always filter by (user_id, kind, period_key) — the primary key
-- already covers that, so no extra index is needed.

-- =============================================================================
-- increment_ai_usage(user_id, kind, period_key, amount)
-- =============================================================================
-- Atomic upsert + increment. Returning a single bigint lets the service layer
-- check the post-increment total against the cap in one round-trip without a
-- read-then-write race.
--
-- A pure Python read-then-write would let two concurrent requests both pass
-- the cap check at amount=499 and both record, leaving the user at 501. The
-- RPC closes that window because the row-level lock from `on conflict ...
-- update` is held for the full statement.

create or replace function increment_ai_usage(
    p_user_id     uuid,
    p_kind        text,
    p_period_key  text,
    p_amount      bigint
) returns bigint
language plpgsql
as $$
declare
    new_total bigint;
begin
    insert into ai_usage_counters (user_id, kind, period_key, amount, updated_at)
    values (p_user_id, p_kind, p_period_key, p_amount, now())
    on conflict (user_id, kind, period_key)
    do update set
        amount = ai_usage_counters.amount + excluded.amount,
        updated_at = now()
    returning amount into new_total;

    return new_total;
end;
$$;

