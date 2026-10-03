-- =============================================================================
-- 0029 — Which month a period's payment is FOR
-- =============================================================================
-- Rent is paid either in advance (due 5 October, for October) or in arrears
-- (due 5 October, for September). Orbi assumed the first. 'previous_month'
-- labels each period by the month before its due date — "Renda de setembro ·
-- vence 5 out" — so what was meant for September reads as September.
--
-- Only the label and the month a period is listed under in a routine's own
-- history change. Due dates, reminders, bubbles and the collection's monthly
-- totals (which count money by when it is due) are untouched.
-- =============================================================================

alter table collection_routines
    add column if not exists covers text not null default 'due_month'
        check (covers in ('due_month', 'previous_month'));
