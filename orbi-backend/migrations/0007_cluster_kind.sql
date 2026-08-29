-- =============================================================================
-- 0007 — Persist cluster `kind`
-- =============================================================================
-- The mobile client used to derive a cluster's kind from its NAME on every
-- render (universeLayout.classifyKind). That made renaming destructive:
--
--   * A rename to a name with no recognised keyword flipped the cluster to
--     kind 'drift', which is grey and anchored at canvas centre — so the
--     cluster visibly teleported and changed colour.
--   * Worse, the client only synthesises its catch-all Drift cluster when no
--     cluster already has kind 'drift'. A renamed cluster impersonating Drift
--     suppressed the real one, and every uncategorised task lost its home.
--
-- Kind is now a stored column, assigned once at creation and only ever changed
-- explicitly. Renames no longer touch it.
--
-- Backfill mirrors the keyword table the client used, so existing clusters keep
-- the kind they render as today and nothing moves on the canvas after deploy.
-- =============================================================================

alter table clusters
    add column if not exists kind text not null default 'drift';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'clusters_kind_check'
    ) then
        alter table clusters
            add constraint clusters_kind_check check (
                kind in ('work', 'health', 'finance', 'personal',
                         'home', 'learning', 'drift')
            );
    end if;
end $$;

-- Backfill. Order matters — first match wins, same as the client's
-- KIND_KEYWORDS array. Only touches rows still sitting on the default.
update clusters set kind = case
    when name ~* '(work|job|office|career)'            then 'work'
    when name ~* '(health|fitness|wellness|gym|medical)' then 'health'
    when name ~* '(finance|money|bills|budget|expense)'  then 'finance'
    when name ~* '(personal|family|social|friends)'      then 'personal'
    when name ~* '(home|house|chores|garden)'            then 'home'
    when name ~* '(learning|study|reading|course)'       then 'learning'
    else 'drift'
end
where kind = 'drift';

create index if not exists clusters_owner_kind_idx on clusters (owner_id, kind);
