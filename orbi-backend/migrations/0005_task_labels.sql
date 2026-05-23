-- =============================================================================
-- 0005_task_labels.sql
-- =============================================================================
-- Adds a short, user-editable label to TaskBubble. The label is what
-- gets rendered inside the bubble on the canvas — title is the full
-- task name, label is the 1-3 word keyword identifier.
--
-- The voice flow lets the LLM extract a label alongside the title.
-- Typed creation derives a label from the title automatically via
-- shortLabel(). Either way the user can override it in the confirm
-- screen or in task-detail edit mode.
--
-- nullable: existing rows have no label; the client falls back to a
-- shortLabel-of-title for them so there's no visible regression.
-- =============================================================================

alter table public.task_bubbles
    add column if not exists label text null;

-- Soft length cap. We hint at ~20 chars in the prompt but enforce 32
-- here to leave room for unicode/emoji and avoid hard rejection if the
-- LLM occasionally overshoots. PostgreSQL doesn't support
-- "ADD CONSTRAINT IF NOT EXISTS" directly, so we wrap the create in
-- an existence check to keep the migration rerunnable.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'task_bubbles_label_length_check'
          and conrelid = 'public.task_bubbles'::regclass
    ) then
        alter table public.task_bubbles
            add constraint task_bubbles_label_length_check
            check (label is null or char_length(label) <= 32);
    end if;
end $$;
