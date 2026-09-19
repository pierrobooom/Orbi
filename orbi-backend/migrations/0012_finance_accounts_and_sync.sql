-- =============================================================================
-- 0012 — Finance accounts, recurring transactions, and the bank-sync seam
-- =============================================================================
-- Finance was a flat list of manually-typed entries against no account at all,
-- so "how much is in my current account" had no answer and every entry had to
-- be typed by hand. This adds the three things that change that: somewhere for
-- money to live, a way for predictable spending to enter itself, and the
-- plumbing for transactions to arrive from a bank.
--
-- ON IBAN, SINCE IT IS THE REASON THIS TABLE HAS THAT COLUMN
-- finance_accounts.iban is a LABEL and a MATCHING KEY. It is not a credential
-- and cannot be used to fetch anything: an IBAN is the address you print on an
-- invoice, known to everyone who has ever paid you, and no bank will hand over
-- a statement to whoever quotes one. Reading an account requires the holder to
-- authenticate at their own bank and consent to a licensed AISP, which returns
-- a token — and that token is what bank_connections stores.
--
-- What the IBAN IS good for, and why it is worth capturing now: when a
-- statement import or a provider feed arrives, it names accounts by IBAN. A
-- user who has already told us theirs gets their transactions filed to the
-- right account with no matching UI at all.
--
-- ONE CALL PER ACCOUNT PER DAY
-- bank_connections.last_synced_at plus next_sync_after is the whole rate
-- limiter. Providers charge per connection per month and some meter calls, so
-- the scheduler claims an account only when its cooldown has passed. That
-- keeps the cost per user flat and predictable regardless of how often the app
-- is opened, which is the only way this survives contact with a £10.99 tier.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------------------

create table if not exists finance_accounts (
    id                uuid primary key default gen_random_uuid(),
    owner_id          uuid not null references user_profiles(id) on delete cascade,
    name              text not null,
    -- Label and match key. Never a credential — see the header.
    iban              text,
    currency          text not null default 'EUR',
    -- The account a new entry defaults to, including one created from a
    -- receipt photo where the user never picks an account at all.
    is_primary        boolean not null default false,
    -- A savings pot or a shared account the user tracks but doesn't want
    -- folded into "what I have". Hiding and excluding are different wishes:
    -- an account can be visible but excluded from the total.
    visible           boolean not null default true,
    include_in_total  boolean not null default true,
    position          int not null default 0,
    -- Balances are DERIVED (opening_balance + the sum of entries), never
    -- stored as a running figure. A stored balance drifts the first time an
    -- entry is edited or deleted and there is no way to tell that it has.
    opening_balance   numeric(12,2) not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create index if not exists finance_accounts_owner_idx
    on finance_accounts (owner_id, position);

-- At most one primary per user. A partial unique index rather than
-- application logic, because "two primaries" is a state the UI cannot
-- render and the default-account lookup cannot resolve.
create unique index if not exists finance_accounts_one_primary_idx
    on finance_accounts (owner_id)
    where is_primary;

-- An IBAN identifies exactly one account, so the same one twice is a
-- duplicate the user will not notice until their totals are wrong.
create unique index if not exists finance_accounts_owner_iban_idx
    on finance_accounts (owner_id, iban)
    where iban is not null;

alter table finance_accounts enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'finance_accounts_self') then
        create policy finance_accounts_self on finance_accounts
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
end $$;

-- -----------------------------------------------------------------------------
-- Entries: where they came from, and which account they hit
-- -----------------------------------------------------------------------------

alter table finance_entries
    add column if not exists account_id uuid references finance_accounts(id) on delete set null;

-- Provider's own id for the transaction. The deduplication key: a daily sync
-- re-fetches a window of days, so the SAME transaction arrives repeatedly and
-- must land once. Nullable because manual entries have no external identity.
alter table finance_entries
    add column if not exists external_id text;

-- What the bank actually called it, before categorisation rewrote it into
-- something human. Kept because the rule-based merchant matcher is only ever
-- as good as the strings it has seen, and this is the corpus for improving it.
alter table finance_entries
    add column if not exists raw_description text;

-- source_type already exists and defaulted to 'manual'. Constrain it now that
-- more than one path can create an entry.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'finance_entries_source_type_check'
    ) then
        alter table finance_entries
            add constraint finance_entries_source_type_check
            check (source_type in ('manual', 'receipt', 'recurring', 'bank', 'import'));
    end if;
end $$;

-- The idempotency guarantee for every automated path. Without it a retried
-- sync, a re-imported statement or a double-fired recurring rule silently
-- doubles someone's spending.
create unique index if not exists finance_entries_external_idx
    on finance_entries (user_id, external_id)
    where external_id is not null;

create index if not exists finance_entries_account_date_idx
    on finance_entries (account_id, entry_date desc);

-- -----------------------------------------------------------------------------
-- Recurring transactions
-- -----------------------------------------------------------------------------
-- Most of a month's spending is the same ten things: rent, the gym, Netflix,
-- the phone bill. Typing them in every month is the single dullest thing a
-- finance app can ask for, and the reason most people stop using one.
--
-- next_run_on is stored rather than computed on read, so "what is due" is an
-- indexed lookup instead of a scan that re-derives every schedule.

create table if not exists recurring_transactions (
    id             uuid primary key default gen_random_uuid(),
    owner_id       uuid not null references user_profiles(id) on delete cascade,
    account_id     uuid references finance_accounts(id) on delete set null,
    merchant       text not null,
    category       text not null,
    amount         numeric(12,2) not null,
    currency       text not null default 'EUR',
    entry_type     text not null check (entry_type in ('income', 'expense')),
    notes          text,
    cadence        text not null check (cadence in ('weekly', 'monthly', 'yearly')),
    -- Every N weeks/months/years. Covers "every 2 weeks" and quarterly
    -- (monthly, interval 3) without inventing cadences for each.
    interval_count int not null default 1 check (interval_count between 1 and 24),
    next_run_on    date not null,
    last_run_on    date,
    -- Optional stop. A 12-month contract should not bill forever.
    end_on         date,
    active         boolean not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create index if not exists recurring_due_idx
    on recurring_transactions (next_run_on)
    where active;

create index if not exists recurring_owner_idx
    on recurring_transactions (owner_id, next_run_on);

alter table recurring_transactions enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'recurring_transactions_self') then
        create policy recurring_transactions_self on recurring_transactions
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
end $$;

-- -----------------------------------------------------------------------------
-- Bank connections — the provider seam
-- -----------------------------------------------------------------------------
-- Deliberately provider-agnostic. Which aggregator this ends up on is an open
-- question (GoCardless/Nordigen closed to new signups; Enable Banking is the
-- current self-serve route), and the answer changes an adapter, not a schema.
--
-- consent_reference is whatever the provider calls its handle — a requisition
-- id, a session id, an access token reference. Opaque here on purpose: the
-- moment this column means something specific, it belongs to one vendor.
--
-- NOTE: no access token or secret is stored in this table. Tokens belong in a
-- secret store, not in a row that every future SELECT * will drag into a log.

create table if not exists bank_connections (
    id                  uuid primary key default gen_random_uuid(),
    owner_id            uuid not null references user_profiles(id) on delete cascade,
    account_id          uuid not null references finance_accounts(id) on delete cascade,
    -- 'enablebanking' | 'gocardless' | 'saltedge' | 'manual' (the no-op used
    -- until a real one is configured).
    provider            text not null,
    institution_id      text,
    -- The provider's id for this account, which is what the sync actually
    -- queries. The IBAN is how we MATCH it to a finance_account; this is how
    -- we FETCH it.
    external_account_id text,
    consent_reference   text,
    -- PSD2 consent expires and must be renewed by the user re-authenticating
    -- at their bank. Stored so the app can warn BEFORE the feed goes silent —
    -- a sync that simply stops is indistinguishable from not spending money.
    consent_expires_at  timestamptz,
    status              text not null default 'pending'
                        check (status in ('pending', 'active', 'expired', 'revoked', 'error')),
    last_synced_at      timestamptz,
    -- The rate limiter. The scheduler only claims connections whose cooldown
    -- has passed, which is what holds this to one call per account per day.
    next_sync_after     timestamptz not null default now(),
    last_error          text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists bank_connections_due_idx
    on bank_connections (next_sync_after)
    where status = 'active';

create index if not exists bank_connections_owner_idx
    on bank_connections (owner_id);

create unique index if not exists bank_connections_account_idx
    on bank_connections (account_id)
    where status in ('pending', 'active');

alter table bank_connections enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where policyname = 'bank_connections_self') then
        create policy bank_connections_self on bank_connections
            for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
    end if;
end $$;

comment on column finance_accounts.iban is
    'Label and matching key for imported/synced transactions. NOT a credential '
    'and never usable to fetch data — see bank_connections for real access.';

comment on column bank_connections.next_sync_after is
    'Earliest moment this connection may be synced again. Enforces the '
    'one-call-per-account-per-day budget regardless of app activity.';
