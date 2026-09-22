-- =============================================================================
-- Telling people a subscription is about to renew, while they can still stop it.
--
-- WHY THIS IS THE MOST VALUABLE NOTIFICATION IN THE APP
-- Every other alert here reports something that already happened: you went
-- over budget, the feed stopped, this was due. A renewal warning is the only
-- one that arrives while the money is still the user's. A gym contract that
-- auto-renews for another year is the single most expensive thing a finance
-- app can fail to mention, and the whole cost of missing it is that nobody
-- looked at a date.
--
-- THE SCHEDULE, AND WHY IT IS THREE
-- Four days, two days, one day. Cancelling usually means a phone call, a
-- web form, or a visit — things that need a working day, not an evening. One
-- warning would land on a bad day and be forgotten; a daily countdown would
-- be nagging. Three is enough to catch a busy week without becoming noise.
--
-- Plus one after: "this renewed today". Not a warning — a receipt. It is the
-- message that teaches someone the feature works, and the one that prompts
-- "actually, cancel it before next month".
--
-- WHY A TOGGLE
-- Rent renews every month and nobody wants four reminders about it. The
-- subscriptions worth warning about are the ones you might not want — a gym,
-- a streaming service, a trial that turned into a bill. Only the user knows
-- which is which, so only the user can say.
-- =============================================================================

alter table recurring_transactions
    add column if not exists notify_enabled boolean not null default true;

-- Which warning has already gone out for the CURRENT occurrence. Reset when
-- next_run_on moves, so every period warns afresh.
alter table recurring_transactions
    add column if not exists notified_stage text
        check (notified_stage in ('d4', 'd2', 'd1', 'renewed'));

-- The occurrence notified_stage refers to. Without it, a rule that renewed
-- yesterday would look like it had already been warned about for next month.
alter table recurring_transactions
    add column if not exists notified_for date;

comment on column recurring_transactions.notify_enabled is
    'Whether to warn before this renews. Default on for new rules, because '
    'the cost of an unwanted renewal is much higher than the cost of one '
    'notification the user then turns off.';

comment on column recurring_transactions.notified_stage is
    'Most recent warning sent for the occurrence in notified_for: d4, d2, d1 '
    'or renewed. Null means nothing said yet for that date.';
