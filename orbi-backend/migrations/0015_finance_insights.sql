-- =============================================================================
-- 0015 — Make finance_insights usable
-- =============================================================================
-- The table has existed since 0001 and nothing has ever written to it. Three
-- columns are missing before it can hold anything worth showing.
--
-- period — which month the insight is about. Without it, regenerating
-- produces a growing pile of observations about different months with no way
-- to tell them apart, and "this month's insights" becomes unanswerable.
-- Regeneration replaces a period rather than appending to it.
--
-- dismissed_at — an insight the user has read and does not want again. Kept
-- rather than deleted: which observations get dismissed immediately is the
-- clearest signal available about which ones are worth generating, and that
-- is exactly the feedback needed to stop paying for the useless ones.
--
-- generated_at is created_at, already present, and is what the once-a-day
-- rate limit reads. Insights cost an AI call; regenerating them every time a
-- screen opens would be the single most expensive mistake in the app.
-- =============================================================================

alter table finance_insights
    add column if not exists period text;

alter table finance_insights
    add column if not exists dismissed_at timestamptz;

-- The insight's subject, when it has one — a merchant, a category. Lets the
-- client deep-link from an observation to the transactions behind it, which
-- is the difference between a remark and something actionable.
alter table finance_insights
    add column if not exists subject text;

-- "Show me this month's insights", the only read path.
create index if not exists finance_insights_user_period_idx
    on finance_insights (user_id, period, created_at desc)
    where dismissed_at is null;

comment on column finance_insights.period is
    'YYYY-MM the insight describes. Regeneration replaces a period rather '
    'than appending, so the list cannot fill with stale observations.';

comment on column finance_insights.dismissed_at is
    'Set when the user clears an insight. Kept rather than deleted — what '
    'gets dismissed is the best available signal about what is worth '
    'generating at all.';
