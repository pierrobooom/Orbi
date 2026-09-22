-- =============================================================================
-- Sharing a task with someone, and agreeing when it is done.
--
-- NO FRIEND LIST
-- CLAUDE.md sketched a UserConnection table — a contacts list you build up
-- before you can share anything. This skips it. Sharing one task with one
-- person is the thing people actually want to do, and putting a friend
-- request in front of it means two acceptances before anything useful
-- happens. A contacts list can be derived later from who you have shared
-- with, which is a better list than one people have to curate.
--
-- INVITED BY EMAIL, AND THE EMAIL IS NOT A LOOKUP
-- A share is addressed to an email, not to a user id. If that address has an
-- account, the invite appears in their app; if it does not, the row waits
-- until someone signs up with it. The sender is never told which — otherwise
-- "share with this address" becomes a way to ask whether any given person
-- has an Orbi account, one address at a time.
--
-- HOW COMPLETION IS AGREED
-- Participants are the owner plus everyone who accepted. Each may say the
-- task is done, and the task closes for everybody once a majority have:
--
--     2 people  -> both          (a majority of 2 is 2)
--     3 people  -> any 2
--     4 people  -> any 3
--
-- Stored as a timestamp per participant rather than a counter, because "who
-- has said yes" is the question the UI has to answer — a count cannot tell
-- someone whether they are the one being waited on.
-- =============================================================================

create table if not exists task_shares (
    id                  uuid primary key default gen_random_uuid(),
    task_id             uuid not null references task_bubbles(id) on delete cascade,
    -- Who sent it. Kept even after acceptance: "shared by Ana" is how the
    -- recipient recognises a bubble that appeared in their universe.
    shared_by_user_id   uuid not null references user_profiles(id) on delete cascade,
    -- Lower-cased at write time. The address is the invitation; the user id
    -- below is filled in once we know who it belongs to.
    invited_email       text not null,
    -- Null until the invited address turns out to have an account. Resolved
    -- on sign-up as well as at invite time, so inviting someone who has not
    -- joined yet still works.
    shared_with_user_id uuid references user_profiles(id) on delete cascade,
    status              text not null default 'pending'
                        check (status in ('pending', 'accepted', 'declined', 'revoked')),
    -- Where the recipient filed it in THEIR universe. Their choice, not the
    -- owner's — the same task can be "Work" to one person and "Home" to
    -- another, and forcing the owner's cluster on both is how a shared task
    -- ends up somewhere that makes sense to neither.
    cluster_id          uuid references clusters(id) on delete set null,
    -- When this participant said it was done. Null means they have not.
    completed_at        timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- One invitation per address per task. A second share to the same person is
-- the same share, not a duplicate to accept twice.
create unique index if not exists task_shares_unique_invite
    on task_shares (task_id, invited_email);

create index if not exists task_shares_recipient_idx
    on task_shares (shared_with_user_id, status);

create index if not exists task_shares_email_idx
    on task_shares (invited_email)
    where shared_with_user_id is null;

create index if not exists task_shares_task_idx
    on task_shares (task_id);

-- The owner's own vote. Everyone else's lives on their share row; without
-- this the owner would be the one participant who could never say "done",
-- or would close it unilaterally by marking the task completed.
alter table task_bubbles
    add column if not exists owner_completed_at timestamptz;

comment on column task_bubbles.owner_completed_at is
    'When the owner said a SHARED task was done. Only meaningful while the '
    'task has accepted shares — an unshared task completes the moment its '
    'owner says so, with no vote to hold.';

alter table task_shares enable row level security;

do $$
begin
    -- Either side of a share can see it: the sender needs to know whether it
    -- was accepted, the recipient needs to see the invitation at all.
    if not exists (select 1 where exists (select 1 from pg_policies where policyname = 'task_shares_participant')) then
        create policy task_shares_participant on task_shares
            for all
            using (auth.uid() = shared_by_user_id or auth.uid() = shared_with_user_id)
            with check (auth.uid() = shared_by_user_id or auth.uid() = shared_with_user_id);
    end if;
end $$;
