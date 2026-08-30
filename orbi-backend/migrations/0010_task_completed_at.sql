-- =============================================================================
-- 0010 — Record when a task was completed
-- =============================================================================
-- Completing a task set status='completed' and nothing else, so "what did I
-- finish this week" had no honest answer: the only timestamp available was
-- updated_at, which also moves when you rename a task, change its due date,
-- or move it between clusters. A task completed a month ago and edited
-- yesterday would show up as completed yesterday.
--
-- completed_at is set by the API when status transitions INTO 'completed',
-- and cleared when it transitions out, so re-opening a task doesn't leave a
-- stale completion date behind.
--
-- Backfill uses updated_at for rows already marked completed. That is a
-- guess, and knowingly so — it's the best signal that exists for history
-- predating this column, and it only affects tasks completed before now.
-- =============================================================================

alter table task_bubbles
    add column if not exists completed_at timestamptz;

update task_bubbles
   set completed_at = updated_at
 where status = 'completed'
   and completed_at is null;

-- Supports "completed in the last N days", the only way this column is read.
create index if not exists task_bubbles_owner_completed_idx
    on task_bubbles (owner_id, completed_at desc)
    where status = 'completed';

comment on column task_bubbles.completed_at is
    'Set when status transitions into completed, cleared when it transitions '
    'out. Distinct from updated_at, which moves on any edit.';
