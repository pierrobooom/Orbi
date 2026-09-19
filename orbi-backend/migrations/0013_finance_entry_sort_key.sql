-- =============================================================================
-- 0013 — A stable sort key for finance entries
-- =============================================================================
-- Bank feeds do not carry a time. Enable Banking returns booking_date and
-- value_date as plain dates and transaction_date as null, so five transfers
-- made on the same afternoon are indistinguishable by date alone. Sorting by
-- (entry_date, created_at) then leaves them in whatever order Postgres felt
-- like, and because a whole sync batch shares one created_at to the second,
-- that order also changed between page loads. Five identical "€5 to Lucas
-- Cassiano" rows shuffling on every refresh is exactly as confusing as it
-- sounds.
--
-- The ordering information does exist — the provider returns transactions
-- newest-first — it was simply being discarded on the way in. sort_key
-- captures it.
--
-- WHY A BIGINT AND NOT A TIMESTAMP
-- A timestamp would have to be invented, and an invented time is a number
-- somebody eventually displays. This is explicitly an ordering token with no
-- meaning as a date: it is only ever compared, never shown and never parsed.
--
-- HOW IT IS BUILT
--   sort_key = (insert epoch milliseconds * 1000) + position from the oldest
-- The left half is monotonic across batches, so a later sync always sorts
-- above an earlier one. The right half preserves the provider's own order
-- within a batch. Together they give a total order that is stable across
-- reads and correct within any single fetch.
--
-- Null for anything created before this migration, and for manual entries
-- where created_at is already the honest answer. Callers sort NULLS LAST and
-- fall back to created_at.
-- =============================================================================

alter table finance_entries
    add column if not exists sort_key bigint;

-- The list view's only ordering query: newest day first, and within a day the
-- highest sort_key first.
create index if not exists finance_entries_user_order_idx
    on finance_entries (user_id, entry_date desc, sort_key desc);

comment on column finance_entries.sort_key is
    'Ordering token only — never a timestamp, never displayed. Preserves the '
    'provider''s transaction order within a sync batch, since bank feeds carry '
    'a date but no time. Null for manual entries; sort NULLS LAST.';
