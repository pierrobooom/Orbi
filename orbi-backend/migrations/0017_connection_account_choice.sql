-- =============================================================================
-- Don't throw away an authorisation we cannot automatically match.
--
-- THE BUG THIS FIXES
-- When a bank returns several approved accounts and none matches the IBAN on
-- file, the callback had nowhere to put the result. It marked the connection
-- errored and discarded the session — so a user who had just been through
-- their bank's login, SCA and consent screens was told to go and do it all
-- again, with a message ("add its IBAN") that was wrong whenever the IBAN was
-- already there.
--
-- A completed authorisation is the expensive part of this whole flow: it
-- costs the user a trip through two apps and a biometric prompt. Guessing
-- which account it refers to is not acceptable — filing someone's
-- transactions against the wrong account is worse than filing none — but
-- neither is throwing it away. The third option is the right one: keep it,
-- and ask.
--
-- WHY THE ACCOUNTS ARE STORED AS JSON
-- They are the provider's own objects and are only ever read back to render
-- a list of choices. Normalising them into columns would mean a schema per
-- provider, and the only fields we care about (a uid to select, and enough
-- identification for a human to recognise the account) are not worth a
-- table that exists for the few minutes between approving and choosing.
-- =============================================================================

alter table bank_connections
    add column if not exists approved_accounts jsonb;

comment on column bank_connections.approved_accounts is
    'Accounts the bank returned as approved, kept only while status = ''choose'' '
    'so the user can say which one this Orbi account is. Cleared on activation '
    '— after that external_account_id is the answer and this is stale.';

-- 'choose' is a real state, not an error: the bank said yes, and the only
-- thing missing is which of the approved accounts the user meant. Rendering
-- it as an error told people something had gone wrong when nothing had.
do $$
begin
    alter table bank_connections drop constraint if exists bank_connections_status_check;
    alter table bank_connections add constraint bank_connections_status_check
        check (status in ('pending', 'active', 'choose', 'expired', 'revoked', 'error'));
end $$;

-- A connection waiting on a choice holds a live consent, so it must block a
-- second connection on the same account exactly as pending and active do.
drop index if exists bank_connections_account_idx;
create unique index if not exists bank_connections_account_idx
    on bank_connections (account_id)
    where status in ('pending', 'active', 'choose');
