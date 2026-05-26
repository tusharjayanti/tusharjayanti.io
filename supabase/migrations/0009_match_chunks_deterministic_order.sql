-- Followup #80 — deterministic tie-breaking for hybrid retrieval.
--
-- match_chunks (introduced in 0004_match_chunks_hybrid.sql) ordered every
-- stage by score alone. When chunks tie on a sort key, Postgres returns them
-- in an unspecified order that can vary between identical executions — so the
-- same query could return a different top-K, or the same chunks in a different
-- order, run to run. That surfaced as eval-metric drift independent of the LLM
-- layer (verified 2026-05-26): even with bit-identical embeddings and the
-- reranker temperature pinned to 0, retrieval@k could shift because a tie at a
-- `limit` boundary resolved differently between runs.
--
-- This migration replaces match_chunks with an identical signature, return
-- shape, and body, adding a secondary sort key — (source_id, chunk_index) — to
-- ALL FIVE ordering sites:
--   1. semantic row_number() window
--   2. semantic CTE `order by ... limit 20` (decides which 20 rows fuse)
--   3. lexical row_number() window (ts_rank ties are common)
--   4. lexical CTE `order by ... limit 20`
--   5. final `order by score desc limit match_count`
-- Each window's ORDER BY and its CTE's LIMIT use the SAME tiebreaker so rank
-- assignment and row selection stay consistent with each other.
--
-- Tiebreaker choice — (source_id, chunk_index): both CTEs filter
-- `where c.source = source_filter`, so source is fixed within a call and the
-- pair is unique (the schema's unique key is (source, source_id, chunk_index)).
-- It is content-derived and stable across DB re-ingests, so eval baselines stay
-- comparable across rebuilds — unlike the random-uuid `id`. This tightens the
-- baseline ahead of M3's tolerance-band design.
--
-- CREATE OR REPLACE keeps the existing 4-arg signature/return type, so no DROP
-- is needed. The grant is re-applied defensively.
--
-- No new test scaffolding (the repo has no live-DB unit-test harness, and a
-- mock can't exercise Postgres tie-ordering). Verify manually post-deploy: run
-- the same query twice against the live DB and confirm identical id-order.
--
-- match_chunks_unified (0008) has the same latent issue; tracked as Followup
-- #83 (it is NOT source-scoped, so it needs the full (source, source_id,
-- chunk_index) key — fixed separately).

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
        row_number() over (
          order by c.embedding <=> query_embedding, c.source_id, c.chunk_index
        ) as rank
      from chunks c
      where c.source = source_filter
        and c.embedding is not null
      order by c.embedding <=> query_embedding, c.source_id, c.chunk_index
      limit 20
    ),
    lexical as (
      select
        c.id, c.source, c.source_id, c.chunk_index, c.content, c.metadata,
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) as rank_score,
        row_number() over (
          order by
            ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc,
            c.source_id,
            c.chunk_index
        ) as rank
      from chunks c
      where c.source = source_filter
        and c.tsv @@ plainto_tsquery('english', query_text)
      order by
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc,
        c.source_id,
        c.chunk_index
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
  order by score desc, source_id, chunk_index
  limit match_count
$$;

grant execute on function match_chunks(vector, text, int, text) to service_role;
