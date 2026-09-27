-- =============================================================================
-- 0028 — Give money periods closed without a payment the payment they imply
-- =============================================================================
-- Before collections.on_task_completed existed (added 2026-09-27), completing
-- a money period from its bubble closed it as 'done' with no payment row. Such
-- a period reads "✓ Pago" with "€0 de €45" and an empty history — nothing to
-- see and nothing to delete if the tick was a mistake.
--
-- This gives each one the payment completing it now records: the full amount,
-- dated the day it was completed, marked auto_settled so reopening its bubble
-- takes it back again. Idempotent: a period that has any payment is skipped,
-- and the closed_reason update only touches rows this just paid.
-- =============================================================================

with orphans as (
    select o.id, o.owner_id, o.amount, o.completed_at
      from routine_occurrences o
      join collection_routines r on r.id = o.routine_id
     where r.kind = 'amount'
       and o.amount is not null
       and o.completed_at is not null
       and o.closed_reason = 'done'
       and not exists (select 1 from routine_payments p where p.occurrence_id = o.id)
),
paid as (
    insert into routine_payments (owner_id, occurrence_id, amount, paid_on, method, auto_settled)
    select owner_id, id, amount, (completed_at at time zone 'Europe/Lisbon')::date, null, true
      from orphans
    returning occurrence_id
)
update routine_occurrences
   set closed_reason = 'paid'
 where id in (select occurrence_id from paid);
