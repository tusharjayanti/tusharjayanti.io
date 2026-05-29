-- Initial RAG schema.
--
-- One table: `chunks`. Holds every retrievable unit across all sources
-- (experience.md, project READMEs, resume.pdf). Designed for:
--   - semantic search via pgvector HNSW index (voyage-3 = 1024 dims)
--   - lexical search via Postgres FTS (tsvector + GIN index)
--   - idempotent re-ingest via content_hash + (source, source_id, chunk_index) unique key
--   - cheap change detection at sync time: hash changed → re-embed, else skip
--
-- Extensions assumed enabled in dashboard: vector, pg_trgm, pgcrypto.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create table chunks (
  id            uuid primary key default gen_random_uuid(),

  -- source taxonomy
  source        text not null check (source in ('experience', 'readme', 'resume')),
  source_id     text not null,
  chunk_index   int  not null check (chunk_index >= 0),

  -- payload
  content       text not null,
  embedding     vector(1024),
  tsv           tsvector generated always as (to_tsvector('english', content)) stored,
  metadata      jsonb not null default '{}'::jsonb,

  -- bookkeeping
  content_hash  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (source, source_id, chunk_index)
);

-- HNSW index for cosine similarity. m=16, ef_construction=64 are pgvector defaults;
-- corpus is small enough that build time is negligible and recall is excellent out of the box.
create index chunks_embedding_idx
  on chunks
  using hnsw (embedding vector_cosine_ops);

-- GIN index for full-text search. Used by hybrid retrieval.
create index chunks_tsv_idx
  on chunks
  using gin (tsv);

-- Lookup index for ingest (upsert by source/source_id) and for source-scoped queries.
create index chunks_source_idx
  on chunks (source, source_id);

-- Auto-maintain updated_at on row updates. Standard Postgres pattern.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger chunks_set_updated_at
  before update on chunks
  for each row
  execute function set_updated_at();
