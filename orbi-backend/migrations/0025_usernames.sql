-- Usernames with a numbered tag: lucas#0001, lucas#0002, …
--
-- Many people will want the same name, so the name alone is not an identity.
-- The pair (name, tag) is. Names compare case-insensitively — "Lucas" and
-- "lucas" are the same name, told apart only by their tags — but are stored
-- as typed, so a person's own capitalisation is what everyone sees.

alter table user_profiles
    add column if not exists username text,
    add column if not exists username_tag integer;

-- The guard of last resort. The function below never produces a duplicate,
-- but this is what holds if anything else ever writes these columns.
create unique index if not exists user_profiles_username_tag_key
    on user_profiles (lower(username), username_tag)
    where username is not null;


-- One row per name ever claimed, holding the last tag handed out.
--
-- WHY A COUNTER AND NOT max(tag) + 1
-- max + 1 reuses numbers. If lucas#0003 renames themselves, the highest
-- remaining "lucas" tag drops back to 2 and the next person to claim
-- "lucas" becomes lucas#0003 — a handle that until yesterday identified
-- someone else. Anyone who had shared tasks with the old #0003 would now be
-- looking at a stranger wearing their name. A counter only ever goes up, so
-- a tag, once issued, never means anybody else.
create table if not exists username_counters (
    name_lower text primary key,
    last_tag   integer not null default 0
);

-- Nobody reads or writes this directly. RLS on with no policies means only
-- the service role can touch it, which is the only thing that should.
alter table username_counters enable row level security;


-- Claim a name for a user and return the tag they were given.
--
-- RACE-SAFE WITHOUT LOCKS
-- The tag comes from a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
-- Postgres takes the row lock for the conflicting key itself, so two people
-- claiming "lucas" at the same instant are serialised on that one row and
-- receive consecutive numbers. No advisory lock, no read-then-write gap.
create or replace function claim_username(p_user uuid, p_name text)
returns table (username text, username_tag integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_current_name text;
    v_current_tag  integer;
    v_next         integer;
begin
    select u.username, u.username_tag
      into v_current_name, v_current_tag
      from user_profiles u
     where u.id = p_user;

    -- Re-saving your own name in a different case keeps your tag. Changing
    -- "lucas" to "Lucas" is a spelling preference, not a new identity, and
    -- burning a fresh number on it would make people's handles churn for
    -- no reason.
    if v_current_name is not null and lower(v_current_name) = lower(p_name) then
        update user_profiles
           set username = p_name, updated_at = now()
         where id = p_user;
        return query select p_name, v_current_tag;
        return;
    end if;

    insert into username_counters as c (name_lower, last_tag)
    values (lower(p_name), 1)
    on conflict (name_lower)
    do update set last_tag = c.last_tag + 1
    returning c.last_tag into v_next;

    update user_profiles
       set username = p_name, username_tag = v_next, updated_at = now()
     where id = p_user;

    return query select p_name, v_next;
end;
$$;

-- SECURITY DEFINER runs with the owner's rights and takes the user id as an
-- argument, so anyone able to call it could claim a name on somebody
-- else's account. Only the backend — which has already verified who is
-- asking — may call it.
revoke execute on function claim_username(uuid, text) from public;
revoke execute on function claim_username(uuid, text) from anon, authenticated;
grant  execute on function claim_username(uuid, text) to service_role;

comment on column user_profiles.username is
    'Chosen display name, as typed. Compared case-insensitively.';
comment on column user_profiles.username_tag is
    'Number telling apart people with the same name. Never reused.';
