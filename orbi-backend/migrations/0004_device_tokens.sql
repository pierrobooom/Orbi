-- =============================================================================
-- 0004_device_tokens.sql
-- =============================================================================
-- Holds Expo push tokens per (user, device) so the backend can fan out
-- reminders to every device the user has the app on. Tokens are issued by
-- Expo (format: "ExponentPushToken[...]") and are stable per device until
-- the user reinstalls the app or wipes the device.
--
-- A user can have multiple tokens — one per device — which is the whole
-- point of storing them in their own table rather than a column on
-- user_profiles. Unique on (user_id, token) so a device that re-registers
-- (same token, same user) upserts cleanly without dupes.
--
-- platform is informational for now ('ios'|'android'|'web'); we use it
-- later when picking different copy or sound profiles per OS.
-- =============================================================================

create table if not exists device_tokens (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references user_profiles(id) on delete cascade,
    token         text not null,
    platform      text not null check (platform in ('ios', 'android', 'web')),
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    unique (user_id, token)
);

-- Fanning out a push starts with "fetch all tokens for this user". The
-- unique constraint above is on (user_id, token); a leading-column index
-- on user_id alone makes the fanout lookup index-only.
create index if not exists idx_device_tokens_user_id on device_tokens (user_id);
