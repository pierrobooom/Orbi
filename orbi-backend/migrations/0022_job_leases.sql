-- =============================================================================
-- One worker at a time, whatever the replica count.
--
-- THE PROBLEM
-- The reminder dispatcher and the finance scheduler run as asyncio loops
-- inside the API process. That is correct for one instance and wrong for two:
-- every replica runs both loops, so every reminder is sent twice and every
-- bank account is synced twice. The second is not just noise — bank data is
-- billed per connected account per month, so the provider invoice is
-- multiplied by the replica count.
--
-- WHY A TABLE AND NOT pg_advisory_lock
-- Advisory locks are held by a session, and this app reaches Postgres through
-- PostgREST, which has no persistent session to hold one. A lease row works
-- through any connection and survives a process disappearing, which an
-- advisory lock also does but only after the connection is noticed as dead.
--
-- WHY IT IS SAFE
-- Claiming is a conditional UPDATE: take the row only if the lease has
-- expired. Under READ COMMITTED, a second updater blocks on the row lock and
-- then RE-EVALUATES its WHERE clause against the committed new version — by
-- which point expires_at is in the future and it no longer matches. So two
-- replicas cannot both win, without any explicit locking.
--
-- WHY A LEASE AND NOT A FLAG
-- A flag needs releasing, and a process that is killed never releases
-- anything. A lease expires on its own, so the worst case for a crashed
-- replica is that the job pauses for one TTL rather than for ever.
-- =============================================================================

create table if not exists job_leases (
    -- 'reminder_dispatcher', 'finance_scheduler'. One row per job, for ever.
    job         text primary key,
    -- Which process currently holds it. Diagnostic, and what lets the holder
    -- renew its own lease without waiting for it to expire.
    holder      text not null,
    expires_at  timestamptz not null,
    updated_at  timestamptz not null default now()
);

comment on table job_leases is
    'Which process may run each background job. Held for a short TTL and '
    'renewed every tick, so a replica that dies stalls the job for one TTL '
    'rather than permanently.';

-- Deliberately NO row-level security and no owner column: these rows belong
-- to the deployment, not to a user, and are only ever touched by the service
-- key from the server itself.
