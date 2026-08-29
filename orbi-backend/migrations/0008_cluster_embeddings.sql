-- =============================================================================
-- 0008 — Cluster embeddings for semantic task→cluster matching
-- =============================================================================
-- Assigning a new task to a cluster used to be a bidirectional substring test
-- between the LLM's free-text domain_hint and each cluster name:
--
--     if hint in name or name in hint
--
-- First match wins, iterated in weight_score order — and every weight_score is
-- 0.0 in practice, so "first" was effectively arbitrary. It also matched on
-- accidental substrings ("work" hits "Homework", "Network") while missing
-- every semantic relation a human would make instantly: a task hinted `work`
-- has no lexical overlap with a cluster called "Freelance", and "MOT booking"
-- shares nothing with "Car Stuff".
--
-- Clusters now carry an embedding of their name + summary, so matching is
-- cosine similarity against the task's own text. Same 1024 dims as
-- task_bubbles and memory_nodes (text-embedding-3-small, dimensions=1024).
--
-- No index: a user has a handful of clusters, not thousands, so the matcher
-- pulls them and compares in Python. An ivfflat index would cost more to
-- maintain than the scan saves.
-- =============================================================================

alter table clusters
    add column if not exists embedding vector(1024);

alter table clusters
    add column if not exists embedding_source text;

comment on column clusters.embedding_source is
    'The exact text that produced `embedding`. Lets the matcher detect a stale '
    'vector after a rename and refresh it, without embedding on every read.';
