-- =============================================================================
-- 0027 — Mark payments recorded by completing a period's bubble
-- =============================================================================
-- Completing a money period's bubble (hold, a notification's Done, voice)
-- records whatever was left as a payment, so the period's history shows how
-- it was settled. Reopening that bubble has to undo exactly that — and only
-- that. Payments the user typed in stay; the one the completion wrote goes.
-- Without a marker the two are indistinguishable, and a reopened period
-- would sit open while reading 100% paid.
-- =============================================================================

alter table routine_payments
    add column if not exists auto_settled boolean not null default false;
