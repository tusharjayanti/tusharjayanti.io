-- Adds a source-unfiltered counterpart to match_chunks for evaluating
-- unified retrieval against the three-tool baseline. Same RRF k=60
-- hybrid as match_chunks (0004_match_chunks_hybrid.sql), same return
-- shape, but no `source_filter` parameter — semantic and BM25 top-20
-- are computed globally across the corpus before fusion.
--
-- This function exists alongside `match_chunks` rather than replacing
-- it. If a future iteration decides to consolidate the three search
-- tools into one, `match_chunks_unified` becomes the production
-- retrieval path; if it decides to keep three tools, this function
-- stays as eval-only infrastructure.

create or replace function match_chunks_unified(
  query_embedding vector(1024),
  query_text text,
  match_count int
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
      where c.embedding is not null
      order by c.embedding <=> query_embedding
      limit 20
    ),
    lexical as (
      select
        c.id, c.source, c.source_id, c.chunk_index, c.content, c.metadata,
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) as rank_score,
        row_number() over (order by ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc) as rank
      from chunks c
      where c.tsv @@ plainto_tsquery('english', query_text)
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

grant execute on function match_chunks_unified(vector, text, int) to service_role;
