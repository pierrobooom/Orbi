-- =============================================================================
-- Categories people can change, and a categoriser that learns.
--
-- WHY CATEGORIES BECOME A TABLE
-- They were a constant in three places: a rule table in Python, a picker array
-- in the recurring screen, another in the limits screen. That works exactly
-- as long as everyone's life is the same shape. A user with a dog, a boat, a
-- band or a chronic illness has a category nobody else needs, and the honest
-- answer to "where do I put this?" was "in Other, for ever".
--
-- Defaults are seeded per user rather than shared, so renaming "Dining" to
-- "Comer fora" is a rename and not a fork. The slug is what code and history
-- refer to; the label is what the user sees and may change freely.
--
-- WHY LEARNED RULES ARE SEPARATE FROM THE STATIC TABLE
-- finance_categorizer.py knows Continente and Netflix. It cannot know
-- "Tasquinha da Mitas", and no amount of maintenance will make it know every
-- neighbourhood restaurant in Europe. But the user knows, and the moment they
-- correct one entry they have told us — for every future transaction from
-- that merchant, at no cost and with no model involved.
--
-- This is also the only categorisation that is allowed to be wrong twice:
-- the user's own correction beats a rule, a model, and anything else.
-- =============================================================================

create table if not exists finance_categories (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references user_profiles(id) on delete cascade,
    -- Stable identifier used by entries, budgets and rules. Never shown.
    slug        text not null,
    -- What the user sees. Theirs to rename.
    label       text not null,
    -- A MaterialIcons name, so a custom category doesn't look like a
    -- second-class citizen next to the seeded ones.
    icon        text,
    color       text,
    -- Seeded categories can be renamed and hidden but not deleted: entries
    -- and budgets already point at them, and a dangling slug renders as
    -- nothing at all.
    is_default  boolean not null default false,
    hidden      boolean not null default false,
    position    integer not null default 0,
    created_at  timestamptz not null default now()
);

create unique index if not exists finance_categories_user_slug_idx
    on finance_categories (user_id, slug);

alter table finance_categories enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'finance_categories_self') then
        create policy finance_categories_self on finance_categories
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
end $$;

-- -----------------------------------------------------------------------------
-- What the user has taught us about a merchant
-- -----------------------------------------------------------------------------

create table if not exists merchant_rules (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references user_profiles(id) on delete cascade,
    -- Lower-cased, accent-stripped merchant name. The match key, not a label.
    merchant    text not null,
    category    text not null,
    -- 'user' beats everything and is never overwritten by automation.
    -- 'ai' is a cached model answer, kept so the same merchant is never paid
    -- for twice, and replaced the moment a user disagrees with it.
    source      text not null default 'user' check (source in ('user', 'ai')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create unique index if not exists merchant_rules_user_merchant_idx
    on merchant_rules (user_id, merchant);

alter table merchant_rules enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'merchant_rules_self') then
        create policy merchant_rules_self on merchant_rules
            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
    end if;
end $$;

comment on table merchant_rules is
    'Merchant to category, per user. Consulted before the static rule table '
    'and before any AI call. A user correction writes one of these, which is '
    'why correcting the same shop twice should never be necessary.';
