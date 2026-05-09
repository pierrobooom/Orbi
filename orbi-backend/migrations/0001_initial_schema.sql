-- Orbi initial schema (Phase 1 + 2 + 3)
-- Run this once in the Supabase SQL editor on a fresh project.
-- Idempotent: every statement is `if not exists` / `or replace` so re-running is safe.

-- =============================================================================
-- Extensions
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";     -- pgvector for semantic memory search

-- =============================================================================
-- Users
-- =============================================================================
-- user_profiles.id matches the Supabase auth.users id so JWT subject -> profile
-- is a direct lookup. Populate this row on first sign-in (handled in the
-- /users router).

create table if not exists user_profiles (
    id                  uuid primary key references auth.users(id) on delete cascade,
    email               text unique not null,
    full_name           text not null,
    subscription_tier   text not null default 'free' check (subscription_tier in ('free','pro','premium')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists user_preferences (
    user_id                     uuid primary key references user_profiles(id) on delete cascade,
    quiet_hours_start           time not null default '22:00',
    quiet_hours_end             time not null default '08:00',
    proactivity_level           int  not null default 3 check (proactivity_level between 1 and 5),
    preferred_reminder_channel  text not null default 'push'
);

-- =============================================================================
-- Clusters (Phase 2)
-- =============================================================================

create table if not exists clusters (
    id                  uuid primary key default gen_random_uuid(),
    owner_id            uuid not null references user_profiles(id) on delete cascade,
    name                text not null,
    summary             text,
    color               text not null default '#6366F1',
    weight_score        float not null default 0.0,
    active_count        int not null default 0,
    parent_cluster_id   uuid references clusters(id) on delete set null,
    created_at          timestamptz not null default now()
);

create index if not exists clusters_owner_weight_idx
    on clusters (owner_id, weight_score desc);

-- =============================================================================
-- TaskBubbles (Phase 1)
-- =============================================================================
-- owner_id and visibility are required from day one per CLAUDE.md so a future
-- sharing feature does not need a breaking migration.

create table if not exists task_bubbles (
    id                  uuid primary key default gen_random_uuid(),
    owner_id            uuid not null references user_profiles(id) on delete cascade,
    title               text not null,
    description         text,
    status              text not null default 'active' check (status in ('active','completed','snoozed','archived')),
    due_at              timestamptz,
    importance          int  not null default 5 check (importance between 1 and 10),
    urgency_score       float not null default 0.0,
    pressure_score      float not null default 0.0,
    domain_hint         text,
    parent_cluster_id   uuid references clusters(id) on delete set null,
    source_type         text not null default 'manual',
    confidence          float not null default 1.0 check (confidence between 0.0 and 1.0),
    visibility          text not null default 'private' check (visibility in ('private','shared','collaborative')),
    embedding           vector(1024),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists task_bubbles_owner_pressure_idx
    on task_bubbles (owner_id, pressure_score desc)
    where status <> 'archived';

create index if not exists task_bubbles_cluster_idx
    on task_bubbles (parent_cluster_id);

-- =============================================================================
-- MemoryNodes (Phase 2) — semantic memory with pgvector
-- =============================================================================

create table if not exists memory_nodes (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references user_profiles(id) on delete cascade,
    content         text not null,
    memory_type     text not null check (memory_type in ('fact','decision','pattern','summary')),
    tags            text[] not null default '{}',
    importance      int  not null default 5 check (importance between 1 and 10),
    source_summary  text,
    embedding       vector(1024),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists memory_nodes_user_updated_idx
    on memory_nodes (user_id, updated_at desc);

-- IVFFlat index for pgvector cosine similarity. Supabase recommends building
-- the index after some data exists, but creating it empty is fine for now.
create index if not exists memory_nodes_embedding_idx
    on memory_nodes using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- RPC consumed by app/db/memory.py::search_memories_by_embedding
create or replace function match_memories(
    p_user_id          uuid,
    p_embedding        vector(1024),
    p_match_count      int default 10,
    p_match_threshold  float default 0.7
)
returns table (
    id              uuid,
    user_id         uuid,
    content         text,
    memory_type     text,
    tags            text[],
    importance      int,
    source_summary  text,
    similarity      float
)
language plpgsql
as $$
begin
    return query
    select
        mn.id, mn.user_id, mn.content, mn.memory_type,
        mn.tags, mn.importance, mn.source_summary,
        1 - (mn.embedding <=> p_embedding) as similarity
    from memory_nodes mn
    where mn.user_id = p_user_id
      and mn.embedding is not null
      and 1 - (mn.embedding <=> p_embedding) > p_match_threshold
    order by mn.embedding <=> p_embedding
    limit p_match_count;
end;
$$;

-- =============================================================================
-- Conversation events (Phase 2) — shared by /chat and /voice
-- =============================================================================

create table if not exists conversation_events (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references user_profiles(id) on delete cascade,
    session_id   uuid not null,
    role         text not null check (role in ('user','assistant','system')),
    content      text not null,
    source       text not null default 'text' check (source in ('voice','text')),
    intent       text,
    agent_used   text,
    tokens_used  int,
    embedding    vector(1024),
    created_at   timestamptz not null default now()
);

create index if not exists conversation_events_session_idx
    on conversation_events (user_id, session_id, created_at);

-- =============================================================================
-- Voice sessions (Phase 3)
-- =============================================================================

create table if not exists voice_sessions (
    id                       uuid primary key default gen_random_uuid(),
    user_id                  uuid not null references user_profiles(id) on delete cascade,
    conversation_session_id  uuid not null,
    kind                     text not null check (kind in ('debrief','capture','query')),
    status                   text not null default 'active' check (status in ('active','completed','abandoned')),
    topic                    text,
    started_at               timestamptz not null default now(),
    ended_at                 timestamptz,
    extraction               jsonb,
    duration_seconds         float
);

create index if not exists voice_sessions_user_started_idx
    on voice_sessions (user_id, started_at desc);

-- =============================================================================
-- Finance (Phase 1)
-- =============================================================================

create table if not exists finance_entries (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references user_profiles(id) on delete cascade,
    amount            numeric(12,2) not null,
    currency          text not null default 'GBP',
    merchant          text not null,
    category          text not null,
    entry_type        text not null check (entry_type in ('income','expense')),
    entry_date        date not null,
    source_type       text not null default 'manual',
    linked_bubble_id  uuid references task_bubbles(id) on delete set null,
    notes             text,
    embedding         vector(1024),
    created_at        timestamptz not null default now()
);

create index if not exists finance_entries_user_date_idx
    on finance_entries (user_id, entry_date desc);

create index if not exists finance_entries_user_category_idx
    on finance_entries (user_id, category);

create table if not exists finance_budgets (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references user_profiles(id) on delete cascade,
    category         text not null,
    monthly_limit    numeric(12,2) not null,
    alert_threshold  float not null default 0.8 check (alert_threshold between 0.0 and 1.0),
    current_spend    numeric(12,2) not null default 0,
    period_start     date not null,
    period_end       date not null,
    unique (user_id, category)
);

create table if not exists finance_insights (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references user_profiles(id) on delete cascade,
    insight_text  text not null,
    category      text not null,
    severity      text not null default 'info' check (severity in ('info','warning','alert')),
    created_at    timestamptz not null default now()
);

create index if not exists finance_insights_user_created_idx
    on finance_insights (user_id, created_at desc);

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- Backend uses the service role key, which bypasses RLS, so these policies
-- only apply if the anon/authenticated key is ever used directly from the
-- client. Defence in depth — turn RLS on for every table that holds user data.

alter table user_profiles         enable row level security;
alter table user_preferences      enable row level security;
alter table clusters              enable row level security;
alter table task_bubbles          enable row level security;
alter table memory_nodes          enable row level security;
alter table conversation_events   enable row level security;
alter table voice_sessions        enable row level security;
alter table finance_entries       enable row level security;
alter table finance_budgets       enable row level security;
alter table finance_insights      enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'user_profiles_self') then
        create policy user_profiles_self on user_profiles
            for all using (auth.uid() = id) with check (auth.uid() = id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'user_preferences_self') then
        create policy user_preferences_self on user_preferences
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'clusters_owner') then
        create policy clusters_owner on clusters
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'task_bubbles_owner') then
        create policy task_bubbles_owner on task_bubbles
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'memory_nodes_owner') then
        create policy memory_nodes_owner on memory_nodes
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'conversation_events_owner') then
        create policy conversation_events_owner on conversation_events
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'voice_sessions_owner') then
        create policy voice_sessions_owner on voice_sessions
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'finance_entries_owner') then
        create policy finance_entries_owner on finance_entries
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'finance_budgets_owner') then
        create policy finance_budgets_owner on finance_budgets
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'finance_insights_owner') then
        create policy finance_insights_owner on finance_insights
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
end$$;
