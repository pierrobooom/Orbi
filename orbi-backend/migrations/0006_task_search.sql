-- Migration 0006: semantic search for task bubbles.
--
-- Adds an IVFFlat index on task_bubbles.embedding for fast cosine
-- similarity lookups, plus a SQL RPC mirroring match_memories so the
-- /tasks/search endpoint can issue a single query and get ranked
-- results back. Embeddings are 1024-dim (OpenAI text-embedding-3-small
-- with the dimensions parameter set to 1024).
--
-- Safe to run repeatedly: every statement uses IF NOT EXISTS /
-- CREATE OR REPLACE.

-- IVFFlat for cosine. lists = 100 is fine until we have ~100k rows
-- per user; beyond that we'd rebuild with a higher list count.
create index if not exists task_bubbles_embedding_idx
    on task_bubbles using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- RPC consumed by app/db/tasks.py::search_tasks_by_embedding.
-- Returns task rows ordered by similarity descending (closest first),
-- filtered by ownership and a configurable similarity threshold.
-- Archived tasks are excluded so search only surfaces active work.
create or replace function search_task_bubbles_by_embedding(
    p_owner_id         uuid,
    p_embedding        vector(1024),
    p_match_count      int default 25,
    p_match_threshold  float default 0.3
)
returns table (
    id                 uuid,
    title              text,
    label              text,
    description        text,
    status             text,
    due_at             timestamptz,
    importance         int,
    pressure_score     float,
    parent_cluster_id  uuid,
    similarity         float
)
language plpgsql
as $$
begin
    return query
    select
        tb.id, tb.title, tb.label, tb.description,
        tb.status::text, tb.due_at, tb.importance, tb.pressure_score,
        tb.parent_cluster_id,
        1 - (tb.embedding <=> p_embedding) as similarity
    from task_bubbles tb
    where tb.owner_id = p_owner_id
      and tb.embedding is not null
      and tb.status <> 'archived'
      and 1 - (tb.embedding <=> p_embedding) > p_match_threshold
    order by tb.embedding <=> p_embedding
    limit p_match_count;
end;
$$;
