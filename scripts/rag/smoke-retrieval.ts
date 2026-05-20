// Smoke test for the M2.1 RAG round-trip: embeds a hardcoded query via
// Voyage with input_type='query' (asymmetric embedding), calls the
// match_chunks RPC over the `chunks` table, and prints the top
// MATCH_COUNT hits in a one-line-per-result format with a content
// preview. Proves the end-to-end path (embed → vector search →
// attribution metadata) before M2.2 layers hybrid scoring on top.

import { embed } from '../../api/_voyage.js';
import { getSupabaseClient } from '../../api/_supabase.js';

const QUERY = 'what did Tushar do at PurpleToko';
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
  score: number;
};

function previewContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CONTENT_PREVIEW_CHARS) return collapsed;
  return `${collapsed.slice(0, CONTENT_PREVIEW_CHARS)}...`;
}

async function main(): Promise<void> {
  const [queryEmbedding] = await embed([QUERY], 'query');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: MATCH_COUNT,
    source_filter: SOURCE_FILTER,
  });
  if (error) throw error;

  const rows = (data ?? []) as MatchRow[];

  console.log(`query: ${QUERY}`);
  console.log();
  rows.forEach((row, i) => {
    const score = row.score.toFixed(3);
    console.log(
      `[${i + 1}] score=${score} chunk=${row.chunk_index} source=${row.source} source_id=${row.source_id}`,
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
