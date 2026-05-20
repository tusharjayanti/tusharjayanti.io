// Smoke test for the M2.2 RAG round-trip: embeds a hardcoded query via
// Voyage with input_type='query' (asymmetric embedding), calls the
// match_chunks RPC over the `chunks` table, and prints the top
// MATCH_COUNT hits with the per-retriever rank breakdown that hybrid
// retrieval surfaces. Score is RRF-fused (k=60) so absolute values live
// in the 0.001–0.04 band — sem_rank and bm25_rank are the more readable
// signals for "did each retriever see this chunk?" "-" means the chunk
// was below that retriever's top-20 (or, for BM25, didn't match the
// tsquery at all).

import { embed } from '../../api/_voyage.js';
import { getSupabaseClient } from '../../api/_supabase.js';

const QUERY = 'Spring Boot Kotlin migration';
const MATCH_COUNT = 3;
const SOURCE_FILTER = 'experience';
const CONTENT_PREVIEW_CHARS = 80;

type MatchRow = {
  id: string;
  source: string;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: {
    h2_heading: string;
    h3_heading: string;
    token_count: number;
  };
  semantic_rank: number | null;
  bm25_rank: number | null;
  semantic_distance: number | null;
  bm25_score: number | null;
  score: number;
};

function previewContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CONTENT_PREVIEW_CHARS) return collapsed;
  return `${collapsed.slice(0, CONTENT_PREVIEW_CHARS)}...`;
}

function rank(value: number | null): string {
  return value === null ? '-' : String(value);
}

async function main(): Promise<void> {
  const [queryEmbedding] = await embed([QUERY], 'query');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    query_text: QUERY,
    match_count: MATCH_COUNT,
    source_filter: SOURCE_FILTER,
  });
  if (error) throw error;

  const rows = (data ?? []) as MatchRow[];

  console.log(`query: ${QUERY}`);
  console.log();
  rows.forEach((row, i) => {
    const score = row.score.toFixed(4);
    console.log(
      `[${i + 1}] score=${score} sem_rank=${rank(row.semantic_rank)} bm25_rank=${rank(row.bm25_rank)} chunk=${row.chunk_index} source=${row.source} source_id=${row.source_id}`,
    );
    console.log(
      `    h2=${row.metadata.h2_heading} | h3=${row.metadata.h3_heading}`,
    );
    console.log(`    ${previewContent(row.content)}`);
  });
}

main().catch((err) => {
  console.error('smoke:retrieval failed:', err);
  process.exit(1);
});
