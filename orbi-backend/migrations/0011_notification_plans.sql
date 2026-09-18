-- =============================================================================
-- 0011 — Notification plans, reminder preferences, per-cluster mute
-- =============================================================================
-- Until now nothing ever fired. reminder_planner.py existed but was imported
-- by nothing, there was no table to hold a scheduled reminder, and the only
-- caller of send_push was the dev smoke-test endpoint. This migration adds
-- the storage the scheduler needs.
--
-- WHY A TABLE AND NOT AN IN-MEMORY TIMER
-- A reminder is a promise. If the API restarts — a deploy, a crash, a laptop
-- lid closing during development — an in-memory timer is silently gone and
-- the user is never told. Plans live in Postgres so the dispatcher can be
-- killed at any moment and recover by asking "what was due while I was
-- away?". It also makes the schedule inspectable, which matters when a user
-- asks why they did or didn't get a nudge.
--
-- FOUR KINDS, ONE PER TASK AT A TIME
--   lead     — before due_at, "don't forget this"
--   due      — at due_at
--   chase    — after due_at, "did you do it?" (this is the one that carries
--              the Done / Snooze actions)
--   escalate — only if a chase went unanswered; fires once, then gives up
--
-- The partial unique index on (task_id, kind) WHERE state = 'pending' is what
-- makes planning idempotent: the planner recomputes the full set of plans for
-- a task on every change and upserts them, and the index guarantees that a
-- task can never accumulate two live reminders of the same kind. Rows that
-- have already been sent or cancelled are excluded from the constraint so the
-- history of what was sent is kept intact.
--
-- TIMEZONE
-- quiet_hours_start/end are `time` columns with no zone, which is only
-- meaningful alongside the zone they are local to. The API has always taken
-- the IANA zone from the request body (chat.py's user_timezone), but a
-- background dispatcher has no request to read it from — it would have had to
-- guess UTC and wake half of Europe at 07:00. So the zone is stored.
-- =============================================================================

create table if not exists notification_plans (
    id            uuid primary key default gen_random_uuid(),
    owner_id      uuid not null references user_profiles(id) on delete cascade,
    task_id       uuid not null references task_bubbles(id) on delete cascade,
    kind          text not null check (kind in ('lead', 'due', 'chase', 'escalate')),
    trigger_at    timestamptz not null,
    -- pending   — scheduled, not yet due
    -- sent      — pushed to the device
    -- answered  — the user acted on it (done / snoozed / rescheduled)
    -- cancelled — the task changed or completed and this plan is moot
    -- skipped   — was due but lost its slot to the daily budget
    state         text not null default 'pending'
                  check (state in ('pending', 'sent', 'answered', 'cancelled', 'skipped')),
    -- How many times the user pushed this reminder back. Feeds the escalation
    -- decision and, eventually, "you've snoozed this six times, is it real?".
    snooze_count  int not null default 0,
    sent_at       timestamptz,
    answered_at   timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- The dispatcher's only hot query: "every pending plan whose time has come,
-- oldest first". Partial so the index stays small — sent rows accumulate
-- forever and are never scanned by this path.
create index if not exists notification_plans_due_idx
    on notification_plans (trigger_at)
    where state = 'pending';

-- Makes replanning idempotent. See the header.
create unique index if not exists notification_plans_task_kind_idx
    on notification_plans (task_id, kind)
    where state = 'pending';

-- "What's scheduled for me?" — the preview endpoint and the per-user budget
-- check both start here.
create index if not exists notification_plans_owner_idx
    on notification_plans (owner_id, trigger_at desc);

alter table notification_plans enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'notification_plans_self') then
        create policy notification_plans_self on notification_plans
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
end $$;

-- =============================================================================
-- Reminder preferences
-- =============================================================================
-- proactivity_level (1-5) already existed and is reused as the density dial —
-- it is turned into a daily notification budget in services/reminder_schedule.py
-- rather than getting a column of its own.
--
-- The two kind toggles are separate because they are genuinely different
-- products. A lead reminder is help; a chase is accountability. Plenty of
-- people want one and find the other insufferable, and folding both into one
-- switch means the only way to escape the half you dislike is to turn off the
-- half you wanted.

alter table user_preferences
    add column if not exists reminders_enabled boolean not null default true;

alter table user_preferences
    add column if not exists lead_reminders_enabled boolean not null default true;

alter table user_preferences
    add column if not exists chase_reminders_enabled boolean not null default true;

alter table user_preferences
    add column if not exists timezone text not null default 'UTC';

comment on column user_preferences.timezone is
    'IANA zone name, e.g. Europe/Lisbon. Required to interpret quiet_hours_*, '
    'which are zone-less time columns. Set by the client from the device.';

-- =============================================================================
-- Per-cluster mute
-- =============================================================================
-- The single most common reason people turn off notifications entirely is one
-- noisy corner of their life — a work cluster during annual leave, a "someday"
-- cluster that was never urgent. Muting the cluster keeps the rest working.
-- Tasks with no cluster (Adrift) are never muted; there is nothing to mute.

alter table clusters
    add column if not exists notifications_muted boolean not null default false;

comment on column clusters.notifications_muted is
    'When true, no reminders are planned or sent for tasks in this cluster. '
    'Existing pending plans are cancelled when the flag is set.';
