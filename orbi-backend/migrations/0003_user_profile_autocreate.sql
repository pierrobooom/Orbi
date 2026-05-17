-- =============================================================================
-- 0003_user_profile_autocreate.sql
-- =============================================================================
-- Auto-create a user_profiles row whenever Supabase Auth creates a new
-- auth.users row (email signup, OAuth, magic link — all go through the same
-- insert). Without this, the mobile client would have to send email on
-- first-write to /users/me, which means trusting client-supplied identity.
-- The trigger pulls email directly from auth.users so it can never disagree
-- with the JWT the same row will issue.
--
-- full_name starts blank; the mobile sign-up screen PATCHes it as soon as
-- the user finishes the form, and the (existing) UI flow gates entry on
-- a non-empty full_name later if we ever need it.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
-- Pin search_path so a later schema with a malicious user_profiles can't
-- shadow ours. Standard hardening for SECURITY DEFINER functions.
set search_path = public
as $$
begin
    insert into public.user_profiles (id, email, full_name)
    values (new.id, new.email, '')
    on conflict (id) do nothing;
    return new;
end;
$$;

-- Replace any prior trigger of the same name so this migration is rerunnable.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Backfill any auth.users that predate this migration (no-op on a fresh DB).
insert into public.user_profiles (id, email, full_name)
select u.id, u.email, ''
from auth.users u
left join public.user_profiles p on p.id = u.id
where p.id is null;
