-- Extends the chunks.source CHECK constraint to allow 'docs', so
-- first-party engineering writeups (docs/rag.md, docs/observability.md,
-- docs/privacy.md, docs/decisions/*.md) can be ingested via the existing
-- markdown ingest pipeline. The TypeScript ChunkSource enum was
-- extended in the same PR (api/_supabase.ts); without this migration the
-- database rejects 'docs' inserts with the runtime error
-- "violates check constraint chunks_source_check".
--
-- Original constraint from 0001_init_chunks.sql:
--   source text not null check (source in ('experience', 'readme', 'resume'))
--
-- ALTER TABLE … DROP CONSTRAINT + ADD CONSTRAINT in a transaction is
-- atomic; readers/writers see either the old or the new constraint, never
-- a window with no constraint. The two statements are wrapped in the
-- transaction the Supabase migration runner already opens, so no
-- explicit BEGIN/COMMIT is needed here.

alter table chunks drop constraint chunks_source_check;

alter table chunks
  add constraint chunks_source_check
  check (source in ('docs', 'experience', 'readme', 'resume'));
