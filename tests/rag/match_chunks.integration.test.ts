// Integration tests for the match_chunks RPC. Hits the live linked
// Supabase project and Voyage API, so it's slow and pulled out of the
// default `npm test` run. Invoke via `npm run test:integration` from a
// shell with .env.local loaded. Skips entirely when SUPABASE_URL,
// SUPABASE_SECRET_KEY, or VOYAGE_API_KEY is missing — keeps the test
// file safe to land in CI without secrets.
//
// All query embeddings are batched into a single Voyage call in
// beforeAll so a full test run costs one HTTP round-trip on the
// embedding side, with one Supabase RPC per test.

import { describe, it, expect, beforeAll } from 'vitest';

import { embed } from '../../api/_voyage.js';
import { getSupabaseClient } from '../../api/_supabase.js';

const HAS_ENV =
  !!process.env.SUPABASE_URL &&
  !!process.env.SUPABASE_SECRET_KEY &&
  !!process.env.VOYAGE_API_KEY;

type MatchRow = {
  id: string;
  source: string;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  semantic_rank: number | null;
  bm25_rank: number | null;
  semantic_distance: number | null;
  bm25_score: number | null;
  score: number;
};

// Queries pre-defined so beforeAll can batch the Voyage embedding call.
// `lexicalOnlyText` is paired with the `semanticDecoy` embedding to
// deliberately decouple the two retrievers in the contract test for
// semantic_rank=null. The function does not require text and embedding
// to come from the same source string.
const QUERIES = {
  both: 'PurpleToko backend architecture',
  semanticOnly: 'neural network training models',
  lexicalOnlyText: 'Datadog monitoring',
  semanticDecoy: 'Anthropic Claude AI agent retrieval system',
  topK: 'PurpleToko backend architecture',
  sourceScope: 'PurpleToko',
} as const;

describe.skipIf(!HAS_ENV)('match_chunks (hybrid)', () => {
  let embeddings: Record<keyof typeof QUERIES, number[]>;

  beforeAll(async () => {
    const keys = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
    const texts = keys.map((k) => QUERIES[k]);
    const { vectors } = await embed(texts, 'query');
    embeddings = Object.fromEntries(
      keys.map((k, i) => [k, vectors[i]]),
    ) as Record<keyof typeof QUERIES, number[]>;
  }, 60_000);

  it('populates both ranks when the query hits both retrievers', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings.both,
      query_text: QUERIES.both,
      match_count: 5,
      source_filter: 'experience',
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as MatchRow[];
    expect(rows.length).toBeGreaterThan(0);

    const dualHit = rows.find(
      (r) => r.semantic_rank !== null && r.bm25_rank !== null,
    );
    expect(dualHit).toBeDefined();
    expect(dualHit!.semantic_distance).not.toBeNull();
    expect(dualHit!.bm25_score).not.toBeNull();
  });

  it('returns rows with bm25_rank=null when the lexical retriever misses', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings.semanticOnly,
      query_text: QUERIES.semanticOnly,
      match_count: 20,
      source_filter: 'experience',
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as MatchRow[];
    expect(rows.length).toBeGreaterThan(0);

    const semanticOnly = rows.find(
      (r) => r.semantic_rank !== null && r.bm25_rank === null,
    );
    expect(semanticOnly).toBeDefined();
    expect(semanticOnly!.bm25_score).toBeNull();
  });

  it('returns rows with semantic_rank=null when the dense retriever misses the lexical hit', async () => {
    // Asymmetric query: embedding aimed at AI/agent space, text aimed at
    // monolith chunks. The point is to verify the function's contract,
    // not realistic usage — a BM25 hit outside the semantic top-20
    // should surface with semantic_rank=null and a defined bm25 path.
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings.semanticDecoy,
      query_text: QUERIES.lexicalOnlyText,
      match_count: 40,
      source_filter: 'experience',
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as MatchRow[];
    expect(rows.length).toBeGreaterThan(0);

    const lexicalOnly = rows.find(
      (r) => r.semantic_rank === null && r.bm25_rank !== null,
    );
    expect(lexicalOnly).toBeDefined();
    expect(lexicalOnly!.semantic_distance).toBeNull();
    expect(lexicalOnly!.bm25_score).not.toBeNull();
  });

  it('respects match_count', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings.topK,
      query_text: QUERIES.topK,
      match_count: 3,
      source_filter: 'experience',
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as MatchRow[];
    expect(rows).toHaveLength(3);
  });

  it('respects source_filter', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embeddings.sourceScope,
      query_text: QUERIES.sourceScope,
      match_count: 10,
      source_filter: 'experience',
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as MatchRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe('experience');
    }
  });
});
