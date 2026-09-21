-- =============================================================================
-- Telling the user their bank feed is about to die, exactly once.
--
-- PSD2 consent is not permanent. The user authorises access at their bank for
-- a fixed window — commonly 90 or 180 days — and when it lapses the provider
-- stops returning data. Nothing breaks loudly: the sync succeeds, returns
-- nothing, and the app keeps showing a total that stopped being true.
--
-- That failure mode is the worst one available to a finance app, because a
-- feed that has silently stopped looks precisely like a month of not
-- spending. The user does not distrust the number — they have no reason to.
--
-- WHY A COLUMN AND NOT A NOTIFICATION LOG
-- The only question is "have we already said this about this connection, in
-- this state?". Recording the state we last announced answers it in the row
-- itself, which means:
--   * expiring -> dead notifies twice, because those need different actions
--     ("renew before it stops" versus "it has stopped")
--   * an hourly sweep re-reading the same expiring connection stays silent
--   * reconnecting clears it, so the next consent period warns again
--
-- A separate log table would answer the same question with a join and a
-- retention problem attached.
-- =============================================================================

alter table bank_connections
    add column if not exists notified_state text
        check (notified_state in ('expiring', 'dead'));

alter table bank_connections
    add column if not exists notified_at timestamptz;

comment on column bank_connections.notified_state is
    'Which warning the user has already been sent about THIS consent period: '
    '''expiring'' (still working, ends soon) or ''dead'' (stopped). Null means '
    'nothing said yet. Cleared when a connection becomes active again, so the '
    'next consent period warns from scratch.';

comment on column bank_connections.notified_at is
    'When that warning went out. Diagnostic only — the sweep decides from '
    'notified_state, never from elapsed time.';
