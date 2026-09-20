-- =============================================================================
-- 0014 — Make spending limits actually do something
-- =============================================================================
-- finance_budgets has existed since 0001 with a monthly_limit and an
-- alert_threshold, and nothing has ever read either. A limit that is never
-- checked is a note to self, not a feature.
--
-- Two columns are needed to check one without becoming a nuisance.
--
-- notified_level — the highest fraction of the limit already alerted about
-- this period. Crossing 80% should say so once, not once an hour for the
-- rest of the month, and going on to exceed 100% should still be worth a
-- second, different message. Storing the level rather than a boolean is what
-- lets both be true.
--
-- notified_period — which month that level belongs to, as YYYY-MM. A new
-- month then resets the alerting for free, with no scheduled job to clear
-- flags and nothing to go wrong if that job fails to run. Comparing against
-- period_start would have worked too, but that column is only as accurate as
-- whoever last wrote a budget row, and this one is unambiguous.
--
-- ON current_spend
-- It is left alone and deliberately unused. It is a stored running total, and
-- stored running totals drift the moment an entry is edited or deleted, with
-- nothing about the row admitting it. Spend is summed from finance_entries
-- every time it is needed, exactly like account balances.
-- =============================================================================

alter table finance_budgets
    add column if not exists notified_level float;

alter table finance_budgets
    add column if not exists notified_period text;

-- Lets a user keep a limit for tracking without being told about it, which
-- is a different thing from deleting the limit.
alter table finance_budgets
    add column if not exists alerts_enabled boolean not null default true;

-- The alert sweep's only query: every budget that could still fire.
create index if not exists finance_budgets_alerting_idx
    on finance_budgets (user_id)
    where alerts_enabled;

comment on column finance_budgets.notified_level is
    'Highest fraction of the limit already alerted about in notified_period. '
    'Stops an 80% warning repeating hourly while still allowing a separate '
    'message when the limit is actually exceeded.';

comment on column finance_budgets.notified_period is
    'YYYY-MM the notified_level belongs to. A new month resets alerting with '
    'no scheduled job to clear flags.';

comment on column finance_budgets.current_spend is
    'DEPRECATED — not read. Spend is summed from finance_entries on demand; a '
    'stored running total drifts as soon as an entry is edited or deleted.';
