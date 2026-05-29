-- Add `embedding_text` column to `chunks`. The text that gets
-- embedded into the dense vector is decoupled from the text that gets
-- shown to the model in tool_result blocks. The hierarchical chunker
-- prefixes embedding_text with the heading path (parent H2 + own H3)
-- so semantic retrieval picks up parent context. The sliding-window
-- chunker (for READMEs) prepends the 150-char overlap from the
-- previous window. `content` itself stays clean — no markdown
-- decoration — so what reaches the model via tool_result is the body,
-- nothing else.
--
-- Nullable so the column can land independently of the re-ingest that
-- backfills it. Once the re-ingest completes, all rows for source IN
-- ('experience', 'resume') have embedding_text populated; README rows
-- arrive populated through the readme ingest path.
--
-- The existing `embedding` (vector) column is unchanged — values
-- previously computed from `content` will be recomputed from
-- `embedding_text` on re-ingest. The `tsv` generated column stays on
-- `content` so BM25 keeps matching against clean body text.

alter table chunks
  add column if not exists embedding_text text;
