-- =============================================================================
-- 0026 — Collections: things that recur and belong to something
-- =============================================================================
-- The rent of each room in a house, the vaccines of each cat, the inspection
-- of each car. Layers, from the outside in:
--
--   cluster (is_collection)      "Imóveis"          — an ordinary cluster
--     collection_resources       "Casa 1"           — parent_id null
--       collection_resources     "Quarto 3 · Marta" — parent_id = Casa 1 (a unit)
--         collection_routines    "Renda €600, monthly on the 15th"  (max 5)
--           routine_occurrences  "October"          — one row per period
--             routine_payments   "€200 on 8 Oct"    — progress is their sum
--             task_bubbles       the bubble for that period
--
-- WHY THE PERIOD IS AN ORDINARY TASK
-- Each occurrence projects into one task bubble, so it lives in the universe,
-- grows as its day comes, and is reminded about by the same pipeline as any
-- task — quiet hours, snooze, Done. A second reminder system would repeat
-- every bug the first one has already had fixed.
--
-- WHO OWNS "IS IT DONE"
-- The task's status. A trigger below mirrors it onto the occurrence, so every
-- path that completes a task — the hold button, a notification, voice, chat —
-- closes the period too, without each of them having to know that periods
-- exist.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Clusters that hold resources
-- ---------------------------------------------------------------------------
alter table clusters
    add column if not exists is_collection boolean not null default false,
    -- What one resource is called here: "imóvel", "gato", "carro". Only
    -- used for "+ Adicionar imóvel"; null falls back to a generic word.
    add column if not exists collection_noun text
        check (collection_noun is null or char_length(collection_noun) between 1 and 24);

-- ---------------------------------------------------------------------------
-- Resources, and their optional units
-- ---------------------------------------------------------------------------
create table if not exists collection_resources (
    id           uuid primary key default gen_random_uuid(),
    owner_id     uuid not null references user_profiles(id) on delete cascade,
    cluster_id   uuid not null references clusters(id) on delete cascade,
    -- Null for a resource ("Casa 1"); set for a unit inside one ("Quarto 3").
    -- One level only — see the trigger below.
    parent_id    uuid references collection_resources(id) on delete cascade,
    name         text not null check (char_length(name) between 1 and 60),
    -- An address, a breed, a plate number.
    subtitle     text check (subtitle is null or char_length(subtitle) <= 80),
    -- The person a unit is about: the tenant of a room.
    person_name  text check (person_name is null or char_length(person_name) <= 60),
    since_on     date,
    position     int not null default 0,
    archived_at  timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists collection_resources_cluster_idx
    on collection_resources (cluster_id, position) where archived_at is null;
create index if not exists collection_resources_parent_idx
    on collection_resources (parent_id) where archived_at is null;

-- A unit sits in a resource, in the same cluster, for the same owner — and a
-- unit cannot hold units. Checked here as well as in the service, because
-- this is what holds if anything else ever writes the table.
create or replace function collection_resources_check_parent()
returns trigger
language plpgsql
as $$
declare
    v_parent collection_resources%rowtype;
begin
    if new.parent_id is null then
        return new;
    end if;
    select * into v_parent from collection_resources where id = new.parent_id;
    if v_parent.id is null then
        raise exception 'parent resource not found';
    end if;
    if v_parent.parent_id is not null then
        raise exception 'a unit cannot contain units';
    end if;
    if v_parent.owner_id <> new.owner_id or v_parent.cluster_id <> new.cluster_id then
        raise exception 'a unit must share its resource''s owner and cluster';
    end if;
    return new;
end;
$$;

drop trigger if exists collection_resources_parent_check on collection_resources;
create trigger collection_resources_parent_check
    before insert or update of parent_id, owner_id, cluster_id on collection_resources
    for each row execute function collection_resources_check_parent();

-- ---------------------------------------------------------------------------
-- Routines
-- ---------------------------------------------------------------------------
create table if not exists collection_routines (
    id               uuid primary key default gen_random_uuid(),
    owner_id         uuid not null references user_profiles(id) on delete cascade,
    resource_id      uuid not null references collection_resources(id) on delete cascade,
    title            text not null check (char_length(title) between 1 and 60),
    -- 'check': done or not done. 'amount': paid towards a target, in parts.
    kind             text not null check (kind in ('check', 'amount')),
    amount           numeric(12,2),
    currency         text not null default 'EUR',
    -- Money coming in (rent received) or going out (a subscription paid).
    direction        text not null default 'income' check (direction in ('income', 'expense')),
    frequency        text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
    interval_count   int not null default 1 check (interval_count between 1 and 24),
    -- The first due date. It fixes the weekday, the day of the month and the
    -- month of the year for every later period.
    anchor_on        date not null,
    due_time         time not null default '09:00',
    -- When a due date passes unfinished:
    --   stay_overdue — it stays open (rent owed is still owed)
    --   skip_ahead   — the next period replaces it (a chore)
    --   from_done    — the next date counts from when it was done (a vaccine)
    on_miss          text not null default 'stay_overdue'
                     check (on_miss in ('stay_overdue', 'skip_ahead', 'from_done')),
    -- Reminders: days before (null = none), on the day, days after (null = none).
    remind_before_days int check (remind_before_days is null or remind_before_days between 1 and 14),
    remind_on_day    boolean not null default true,
    remind_after_days int check (remind_after_days is null or remind_after_days between 1 and 7),
    -- Also write each payment into Money.
    log_to_finance   boolean not null default false,
    finance_category text,
    -- The last period that has an occurrence. Generation continues from here,
    -- so a period is never created twice and never skipped.
    materialized_through date,
    position         int not null default 0,
    archived_at      timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint collection_routines_amount_check
        check ((kind = 'check' and amount is null) or (kind = 'amount' and amount > 0))
);

create index if not exists collection_routines_resource_idx
    on collection_routines (resource_id, position) where archived_at is null;
create index if not exists collection_routines_live_idx
    on collection_routines (owner_id) where archived_at is null;

-- At most five live routines per resource or unit — the boxes on one screen.
create or replace function collection_routines_check_limit()
returns trigger
language plpgsql
as $$
begin
    if new.archived_at is null and (
        select count(*) from collection_routines
         where resource_id = new.resource_id
           and archived_at is null
           and id <> new.id
    ) >= 5 then
        raise exception 'a resource can have at most 5 routines';
    end if;
    return new;
end;
$$;

drop trigger if exists collection_routines_limit on collection_routines;
create trigger collection_routines_limit
    before insert or update of resource_id, archived_at on collection_routines
    for each row execute function collection_routines_check_limit();

-- ---------------------------------------------------------------------------
-- Occurrences: one per routine per period
-- ---------------------------------------------------------------------------
create table if not exists routine_occurrences (
    id             uuid primary key default gen_random_uuid(),
    owner_id       uuid not null references user_profiles(id) on delete cascade,
    routine_id     uuid not null references collection_routines(id) on delete cascade,
    -- The period's due date. Together with routine_id it identifies the
    -- period, so creating the same period twice is impossible.
    period_on      date not null,
    due_at         timestamptz not null,
    -- The target for this period, copied from the routine when the period was
    -- created — raising the rent in November does not rewrite October.
    amount         numeric(12,2),
    completed_at   timestamptz,
    -- done: marked finished. paid: payments reached the amount.
    -- skipped: replaced by a later period (skip_ahead) or its task deleted.
    closed_reason  text check (closed_reason in ('done', 'paid', 'skipped')),
    created_at     timestamptz not null default now(),
    constraint routine_occurrences_period_key unique (routine_id, period_on)
);

create index if not exists routine_occurrences_routine_idx
    on routine_occurrences (routine_id, period_on desc);

-- ---------------------------------------------------------------------------
-- Payments towards an occurrence
-- ---------------------------------------------------------------------------
create table if not exists routine_payments (
    id                uuid primary key default gen_random_uuid(),
    owner_id          uuid not null references user_profiles(id) on delete cascade,
    occurrence_id     uuid not null references routine_occurrences(id) on delete cascade,
    amount            numeric(12,2) not null check (amount > 0),
    paid_on           date not null,
    method            text check (method in ('mbway', 'transfer', 'cash', 'card', 'other')),
    finance_entry_id  uuid references finance_entries(id) on delete set null,
    created_at        timestamptz not null default now()
);

create index if not exists routine_payments_occurrence_idx
    on routine_payments (occurrence_id, paid_on);

-- ---------------------------------------------------------------------------
-- Tasks: the bubble for a period, and per-task reminder choices
-- ---------------------------------------------------------------------------
alter table task_bubbles
    add column if not exists routine_occurrence_id uuid
        references routine_occurrences(id) on delete set null,
    -- Minutes before the deadline for the heads-up. Null: the default for the
    -- task's importance. 0: no heads-up.
    add column if not exists reminder_lead_minutes int
        check (reminder_lead_minutes is null or reminder_lead_minutes between 0 and 20160),
    add column if not exists reminder_on_due boolean not null default true,
    -- Minutes after the deadline for the "did you?" chase. Null: default. 0: none.
    add column if not exists reminder_chase_minutes int
        check (reminder_chase_minutes is null or reminder_chase_minutes between 0 and 10080);

-- One bubble per period, ever.
create unique index if not exists task_bubbles_routine_occurrence_key
    on task_bubbles (routine_occurrence_id) where routine_occurrence_id is not null;

-- The task's status is the truth about whether a period is finished. Mirror
-- it onto the occurrence whatever path changed it.
create or replace function task_bubbles_sync_occurrence()
returns trigger
language plpgsql
as $$
begin
    if new.routine_occurrence_id is null or new.status is not distinct from old.status then
        return new;
    end if;
    if new.status = 'completed' then
        update routine_occurrences
           set completed_at = coalesce(completed_at, now()),
               closed_reason = coalesce(closed_reason, 'done')
         where id = new.routine_occurrence_id;
    elsif new.status = 'archived' then
        -- The bubble was deleted: the user has decided about this period.
        update routine_occurrences
           set completed_at = coalesce(completed_at, now()),
               closed_reason = coalesce(closed_reason, 'skipped')
         where id = new.routine_occurrence_id;
    elsif new.status = 'active' and old.status in ('completed', 'archived') then
        update routine_occurrences
           set completed_at = null, closed_reason = null
         where id = new.routine_occurrence_id;
    end if;
    return new;
end;
$$;

drop trigger if exists task_bubbles_occurrence_sync on task_bubbles;
create trigger task_bubbles_occurrence_sync
    after update of status on task_bubbles
    for each row execute function task_bubbles_sync_occurrence();

-- ---------------------------------------------------------------------------
-- Money: payments can be written into finance
-- ---------------------------------------------------------------------------
alter table finance_entries drop constraint if exists finance_entries_source_type_check;
alter table finance_entries
    add constraint finance_entries_source_type_check
    check (source_type in ('manual', 'receipt', 'recurring', 'bank', 'import', 'routine'));

-- ---------------------------------------------------------------------------
-- Row level security: each person sees only their own
-- ---------------------------------------------------------------------------
alter table collection_resources enable row level security;
alter table collection_routines  enable row level security;
alter table routine_occurrences  enable row level security;
alter table routine_payments     enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'collection_resources_self') then
        create policy collection_resources_self on collection_resources
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'collection_routines_self') then
        create policy collection_routines_self on collection_routines
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'routine_occurrences_self') then
        create policy routine_occurrences_self on routine_occurrences
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
    if not exists (select 1 from pg_policies where policyname = 'routine_payments_self') then
        create policy routine_payments_self on routine_payments
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
end $$;
