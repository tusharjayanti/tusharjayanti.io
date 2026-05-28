-- Followup #83 — deterministic tie-breaking for the unified hybrid
-- retrieval function. Sibling fix to 0009 (which fixed match_chunks).
--
-- match_chunks_unified (introduced in 0008) had no secondary sort key
-- on any of its ORDER BY sites. As with match_chunks before 0009, ties
-- on the sort keys (RRF-fused score ties are common; ts_rank ties are
-- common; semantic-distance ties are rare but possible) resolve in
-- unspecified, run-to-run-variable order — so the same `--unified`
-- query could return a different top-K or the same top-K in a different
-- order across identical executions. This is eval-affecting:
-- scripts/eval/retrieval.ts uses --unified to measure the unified
-- retrieval baseline and the cross-source (Q31) experiment, both of
-- which need stable ordering to be diff-comparable run-over-run.
--
-- This migration replaces match_chunks_unified with an identical
-- signature, return shape, and body, adding a secondary sort key —
-- (source, source_id, chunk_index) — to ALL FIVE ordering sites:
--   1. semantic row_number() window
--   2. semantic CTE `order by ... limit 20` (decides which 20 rows fuse)
--   3. lexical row_number() window (ts_rank ties are common)
--   4. lexical CTE `order by ... limit 20`
--   5. final `order by score desc limit match_count`
-- Each window's ORDER BY and its CTE's LIMIT use the SAME tiebreaker so
-- rank assignment and row selection stay consistent with each other,
-- mirroring 0009's approach.
--
-- Tiebreaker choice — (source, source_id, chunk_index): unlike
-- match_chunks (0009), this function is NOT source-scoped — neither
-- CTE filters by source — so the 2-tuple `(source_id, chunk_index)` is
-- NOT unique across the candidate set (today's source_ids happen to be
-- disjoint by convention, but that's not a schema-enforced invariant
-- and a future source could collide). The full 3-tuple is the schema's
-- actual unique key (`chunks_source_source_id_chunk_index_key` from
-- 0001) and is content-derived + stable across re-ingests, so eval
-- baselines stay comparable across rebuilds.
--
-- CREATE OR REPLACE keeps the existing 3-arg signature/return type, so
-- no DROP is needed. The grant is re-applied defensively (same pattern
-- as 0009).
--
-- No new test scaffolding (no live-DB unit-test harness in CI; mocks
-- can't exercise Postgres tie-ordering). Verify manually post-deploy:
-- apply the migration via `supabase db push`, then run the same
-- `npm run eval:retrieval -- --mode=unified` query twice against the
-- live DB and confirm identical id-order in the top-K of every query.

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
        row_number() over (
          order by
            c.embedding <=> query_embedding,
            c.source,
            c.source_id,
            c.chunk_index
        ) as rank
      from chunks c
      where c.embedding is not null
      order by
        c.embedding <=> query_embedding,
        c.source,
        c.source_id,
        c.chunk_index
      limit 20
    ),
    lexical as (
      select
        c.id, c.source, c.source_id, c.chunk_index, c.content, c.metadata,
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) as rank_score,
        row_number() over (
          order by
            ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc,
            c.source,
            c.source_id,
            c.chunk_index
        ) as rank
      from chunks c
      where c.tsv @@ plainto_tsquery('english', query_text)
      order by
        ts_rank(c.tsv, plainto_tsquery('english', query_text)) desc,
        c.source,
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
  order by score desc, source, source_id, chunk_index
  limit match_count
$$;

grant execute on function match_chunks_unified(vector, text, int) to service_role;
