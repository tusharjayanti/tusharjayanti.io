// executeTool dispatch + no-match guardrail tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('./_voyage.js', () => ({
  embed: mocks.embed,
}));

vi.mock('./_supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: mocks.rpc,
  }),
}));

const { executeTool, isToolName, SEARCH_README, TOOLS, NO_MATCH_TOOL_RESULT } =
  await import('./_tools.js');

// semantic_distance values to drive cosine-similarity threshold tests.
// Cosine similarity = 1 - semantic_distance. With the default 0.3
// floor, distance 0.1 passes (sim 0.9), distance 0.8 fails (sim 0.2).
const PASSING_DISTANCE = 0.1;
const FAILING_DISTANCE = 0.8;

function row(opts: {
  chunk_index?: number;
  semantic_distance: number | null;
  score?: number;
}) {
  return {
    chunk_index: opts.chunk_index ?? 0,
    content: `fake chunk body ${opts.chunk_index ?? 0}`,
    metadata: {
      h2_heading: 'H2',
      h3_heading: 'H3',
      token_count: 50,
    },
    score: opts.score ?? 0.0164,
    semantic_distance: opts.semantic_distance,
  };
}

describe('executeTool — dispatch', () => {
  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.rpc.mockReset();
    mocks.embed.mockResolvedValue([new Array(1024).fill(0.1)]);
    mocks.rpc.mockResolvedValue({
      data: [row({ semantic_distance: PASSING_DISTANCE })],
      error: null,
    });
  });

  it('appears in the exported TOOLS array with the expected name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain(SEARCH_README);
    expect(SEARCH_README).toBe('search_readme');
  });

  it('isToolName recognizes search_readme', () => {
    expect(isToolName('search_readme')).toBe(true);
    expect(isToolName('not_a_tool')).toBe(false);
  });

  it('calls match_chunks with source_filter="readme"', async () => {
    await executeTool('search_readme', 'how does vox-agent work');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mocks.rpc.mock.calls[0]!;
    expect(fnName).toBe('match_chunks');
    expect(args).toMatchObject({
      query_text: 'how does vox-agent work',
      match_count: 3,
      source_filter: 'readme',
    });
    expect(args.query_embedding).toHaveLength(1024);
  });

  it('formats tool_result with source=readme prefix in each chunk', async () => {
    const result = await executeTool('search_readme', 'x');
    expect(result.metadata.source).toBe('readme');
    expect(result.metadata.no_match).toBe(false);
    expect(result.formatted).toContain('[Source: readme,');
  });
});

describe('executeTool — no-match guardrail', () => {
  const originalEnv = process.env.RAG_MIN_COSINE_SIMILARITY;

  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.rpc.mockReset();
    mocks.embed.mockResolvedValue([new Array(1024).fill(0.1)]);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RAG_MIN_COSINE_SIMILARITY;
    } else {
      process.env.RAG_MIN_COSINE_SIMILARITY = originalEnv;
    }
  });

  it('passes through normally when every chunk is above the cosine floor', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        row({ chunk_index: 0, semantic_distance: PASSING_DISTANCE, score: 0.0328 }),
        row({ chunk_index: 1, semantic_distance: PASSING_DISTANCE, score: 0.0161 }),
      ],
      error: null,
    });
    const result = await executeTool('search_experience', 'q');
    expect(result.metadata.no_match).toBe(false);
    expect(result.metadata.chunk_ids).toEqual([0, 1]);
    expect(result.formatted).not.toBe(NO_MATCH_TOOL_RESULT);
    expect(result.formatted).toContain('[Source: experience');
  });

  it('returns the no-match instruction when every chunk fails the cosine floor', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        row({ chunk_index: 0, semantic_distance: FAILING_DISTANCE }),
        row({ chunk_index: 1, semantic_distance: FAILING_DISTANCE }),
      ],
      error: null,
    });
    const result = await executeTool('search_experience', 'spacex stories');
    expect(result.metadata.no_match).toBe(true);
    expect(result.metadata.chunk_ids).toEqual([]);
    expect(result.metadata.top_scores).toEqual([]);
    expect(result.formatted).toBe(NO_MATCH_TOOL_RESULT);
    expect(result.formatted).toContain('MUST NOT fabricate');
  });

  it('filters out chunks below the floor and keeps the rest', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        row({ chunk_index: 0, semantic_distance: PASSING_DISTANCE }),
        row({ chunk_index: 1, semantic_distance: FAILING_DISTANCE }),
        row({ chunk_index: 2, semantic_distance: PASSING_DISTANCE }),
      ],
      error: null,
    });
    const result = await executeTool('search_resume', 'mixed query');
    expect(result.metadata.no_match).toBe(false);
    expect(result.metadata.chunk_ids).toEqual([0, 2]);
    expect(result.formatted).not.toContain('fake chunk body 1');
    expect(result.formatted).toContain('fake chunk body 0');
    expect(result.formatted).toContain('fake chunk body 2');
  });

  it('treats rows with null semantic_distance as failing the floor (BM25-only hits)', async () => {
    // BM25-only matches (no semantic anchor) get filtered as
    // term-overlap noise per spec.
    mocks.rpc.mockResolvedValue({
      data: [row({ chunk_index: 0, semantic_distance: null })],
      error: null,
    });
    const result = await executeTool('search_readme', 'lexical-only term');
    expect(result.metadata.no_match).toBe(true);
    expect(result.formatted).toBe(NO_MATCH_TOOL_RESULT);
  });

  it('returns no-match when the RPC returns zero rows', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const result = await executeTool('search_readme', 'q');
    expect(result.metadata.no_match).toBe(true);
    expect(result.formatted).toBe(NO_MATCH_TOOL_RESULT);
  });

  it('respects RAG_MIN_COSINE_SIMILARITY env override', async () => {
    // Tighten the floor to 0.95 — a chunk with cosine sim 0.9 (passing
    // at the default 0.3) now fails.
    process.env.RAG_MIN_COSINE_SIMILARITY = '0.95';
    mocks.rpc.mockResolvedValue({
      data: [row({ chunk_index: 0, semantic_distance: PASSING_DISTANCE })],
      error: null,
    });
    const result = await executeTool('search_readme', 'q');
    expect(result.metadata.no_match).toBe(true);
  });
});
