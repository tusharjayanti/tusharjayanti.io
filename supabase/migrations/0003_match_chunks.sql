-- M2.1.5 — match_chunks: v1 cosine-similarity retrieval over the
-- `chunks` table. Filters by `source` (so a query can be scoped to
-- experience / readme / resume) and returns the top `match_count`
-- rows ordered by ascending cosine distance. The score is the cosine
-- similarity (1 - distance) for caller-side ranking display.
--
-- M2.2 will extend this in place via a new `create or replace`
-- migration to add hybrid (BM25 + dense) scoring.

create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int,
  source_filter text
) returns table (
  id uuid,
  source text,
  source_id text,
  chunk_index int,
  content text,
  metadata jsonb,
  score float
) language sql stable as $$
  select id, source, source_id, chunk_index, content, metadata,
         1 - (embedding <=> query_embedding) as score
  from chunks
  where source = source_filter and embedding is not null
  order by embedding <=> query_embedding
  limit match_count
$$;

grant execute on function match_chunks(vector, int, text) to service_role;
