-- match_chunks extended to hybrid retrieval (semantic + BM25) via
-- Reciprocal Rank Fusion. The dense path is unchanged from the v1
-- function in 0003_match_chunks.sql; the sparse path uses Postgres FTS
-- with the 'english' config matching the `tsv` generated column from
-- 0001_init_chunks.sql. RRF constant k = 60 is canonical (Cormack et
-- al. 2009 "Reciprocal Rank Fusion outperforms Condorcet and
-- individual rank learning methods") with equal weight on both
-- retrievers; alternative weights belong to a future revision once
-- eval-suite ground truth exists, not tuned speculatively.
-- Over-retrieves top-20 from each retriever and fuses to
-- top-`match_count`; the Haiku reranker reads from this function's
-- output and reshuffles the top-K. The function signature gains a
-- `query_text` parameter so the BM25 path doesn't have to round-trip
-- back to the caller — semantic-only callers must still pass it (a
-- literal "" is valid and produces an empty tsquery match).
--
-- The return type changes from the 7 columns of
-- 0003_match_chunks.sql to 11, which Postgres treats as a different
-- function. Drop the 0003 signature explicitly before CREATE OR
-- REPLACE; this also drops the 0002_chunks_grants.sql grant, so
-- re-grant at the bottom.

drop function if exists match_chunks(vector, int, text);

create or replace function match_chunks(
  query_embedding vector(1024),
  query_text text,
  match_count int,
  source_filter text
) returns table (
  id uuid,
  source text,
  source_id text,
  chunk_index int,
  content text,
  metadata jsonb,
  semantic_rank int,
  bm25_rank int,
  semantic_distance float,
  bm25_score float,
  score float
) language sql stable as $$
  with
    semantic as (
      select
        c.id, c.source, c.source_id, c.chunk_index, c.content, c.metadata,
        c.embedding <=> query_embedding as distance,
        row_number() over (order by c.embedding <=> query_embedding) as rank
      from chunks c
      where c.source = source_filter
        and c.embedding is not null
      order by c.embedding <=> query_embedding
      limit 20
    ),
    lexical as (
      select
        c.id, c.source, c.source_id, c.chunk_index, c.content, c.metadata,
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) as rank_score,
        row_number() over (order by ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc) as rank
      from chunks c
      where c.source = source_filter
        and c.tsv @@ plainto_tsquery('english', query_text)
      order by ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc
      limit 20
    ),
    fused as (
      select
        coalesce(s.id, l.id) as id,
        coalesce(s.source, l.source) as source,
        coalesce(s.source_id, l.source_id) as source_id,
        coalesce(s.chunk_index, l.chunk_index) as chunk_index,
        coalesce(s.content, l.content) as content,
        coalesce(s.metadata, l.metadata) as metadata,
        s.rank::int as semantic_rank,
        l.rank::int as bm25_rank,
        s.distance as semantic_distance,
        l.rank_score as bm25_score,
        coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + l.rank), 0) as score
      from semantic s
      full outer join lexical l on s.id = l.id
    )
  select *
  from fused
  order by score desc
  limit match_count
$$;

grant execute on function match_chunks(vector, text, int, text) to service_role;
