// executeTool dispatch + no-match guardrail tests. The cosine
// pre-filter lives in the reranker module; these tests still drive
// it because the reranker's skip-condition (≤3 candidates) bypasses
// Haiku for these small fixtures.

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

// semantic_distance values to drive cosine-similarity pre-filter
// tests. Cosine similarity = 1 - semantic_distance. With the default
// 0.15 pre-filter, distance 0.1 passes (sim 0.9), distance 0.9 fails
// (sim 0.1).
const PASSING_DISTANCE = 0.1;
const FAILING_DISTANCE = 0.9;

function row(opts: {
  chunk_index?: number;
  semantic_distance: number | null;
  score?: number;
  source_id?: string;
}) {
  return {
    source_id: opts.source_id ?? `src-${opts.chunk_index ?? 0}`,
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
    mocks.embed.mockResolvedValue({
      vectors: [new Array(1024).fill(0.1)],
      tokens: 7,
    });
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
    await executeTool('search_readme', { query: 'how does vox-agent work' });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mocks.rpc.mock.calls[0]!;
    expect(fnName).toBe('match_chunks');
    expect(args).toMatchObject({
      query_text: 'how does vox-agent work',
      match_count: 10,
      source_filter: 'readme',
    });
    expect(args.query_embedding).toHaveLength(1024);
  });

  it('formats tool_result with source=readme prefix in each chunk', async () => {
    const result = await executeTool('search_readme', { query: 'x' });
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
    mocks.embed.mockResolvedValue({
      vectors: [new Array(1024).fill(0.1)],
      tokens: 7,
    });
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
        row({
          chunk_index: 0,
          semantic_distance: PASSING_DISTANCE,
          score: 0.0328,
        }),
        row({
          chunk_index: 1,
          semantic_distance: PASSING_DISTANCE,
          score: 0.0161,
        }),
      ],
      error: null,
    });
    const result = await executeTool('search_experience', { query: 'q' });
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
    const result = await executeTool('search_experience', {
      query: 'spacex stories',
    });
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
    const result = await executeTool('search_resume', { query: 'mixed query' });
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
    const result = await executeTool('search_readme', {
      query: 'lexical-only term',
    });
    expect(result.metadata.no_match).toBe(true);
    expect(result.formatted).toBe(NO_MATCH_TOOL_RESULT);
  });

  it('returns no-match when the RPC returns zero rows', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const result = await executeTool('search_readme', { query: 'q' });
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
    const result = await executeTool('search_readme', { query: 'q' });
    expect(result.metadata.no_match).toBe(true);
  });
});

describe('executeTool — span wiring', () => {
  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.rpc.mockReset();
    mocks.embed.mockResolvedValue({
      vectors: [new Array(1024).fill(0.1)],
      tokens: 7,
    });
    mocks.rpc.mockResolvedValue({
      data: [row({ chunk_index: 0, semantic_distance: PASSING_DISTANCE })],
      error: null,
    });
  });

  it('creates embedding/retrieval/rerank children with the right usageDetails', async () => {
    const children: Record<string, { end: ReturnType<typeof vi.fn> }> = {};
    // embedding + rerank are generations (carry tokens); retrieval is a
    // plain span. The stub records both factory methods by child name.
    const makeChild = (body: { name: string }) => {
      const child = { end: vi.fn() };
      children[body.name] = child;
      return child;
    };
    const parentSpan = {
      generation: vi.fn(makeChild),
      span: vi.fn(makeChild),
    };

    await executeTool(
      'search_readme',
      { query: 'q' },
      parentSpan as unknown as Parameters<typeof executeTool>[2],
    );

    // Three child observations total: two generations + one span.
    expect(parentSpan.generation).toHaveBeenCalledTimes(2);
    expect(parentSpan.span).toHaveBeenCalledTimes(1);
    const genNames = parentSpan.generation.mock.calls.map((c) => c[0]!.name);
    expect(genNames).toEqual(['embedding', 'rerank']);
    expect(parentSpan.span.mock.calls[0]![0].name).toBe('retrieval');

    // embedding + rerank carry token usage; retrieval (Supabase RPC)
    // does not.
    expect(children.embedding!.end).toHaveBeenCalledWith(
      expect.objectContaining({ usageDetails: expect.any(Object) }),
    );
    expect(children.rerank!.end).toHaveBeenCalledWith(
      expect.objectContaining({ usageDetails: expect.any(Object) }),
    );
    const retrievalArg = children.retrieval!.end.mock.calls[0]![0];
    expect(retrievalArg).not.toHaveProperty('usageDetails');
  });
});

describe('executeTool — fetch_url', () => {
  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.rpc.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('FETCH_URL constant is in TOOLS and recognized by isToolName', async () => {
    const {
      FETCH_URL: FU,
      TOOLS: T,
      isToolName: isT,
    } = await import('./_tools.js');
    expect(T.map((t) => t.name)).toContain(FU);
    expect(isT('fetch_url')).toBe(true);
  });

  it('happy path: formats tool_result with the fetched markdown + sourceUrl header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          '<html><body><h1>Job Posting</h1><p>Backend role.</p></body></html>',
          {
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
          },
        ),
      ),
    );
    // Response.url is read-only when constructed plainly — defineProperty
    // simulates the post-redirect URL fetch() exposes.
    const originalFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    originalFetch.mockImplementationOnce(async () => {
      const res = new Response(
        '<html><body><h1>Job Posting</h1><p>Backend role.</p></body></html>',
        {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
        },
      );
      Object.defineProperty(res, 'url', {
        value: 'https://example.com/job/42',
      });
      return res;
    });

    const result = await executeTool('fetch_url', {
      url: 'https://example.com/job/42',
    });
    expect(result.metadata.source).toBe('url');
    expect(result.metadata.no_match).toBe(false);
    expect(result.metadata.fetch_url?.error).toBeNull();
    expect(result.metadata.fetch_url?.truncated).toBe('none');
    expect(result.metadata.fetch_url?.source_url).toBe(
      'https://example.com/job/42',
    );
    expect(result.formatted).toContain('[Fetched: https://example.com/job/42]');
    expect(result.formatted).toContain('Job Posting');
    expect(result.formatted).toContain('Backend role');
  });

  it('error path: 404 surfaces as a tool_result error string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        const res = new Response('not found', {
          status: 404,
          headers: new Headers({ 'content-type': 'text/html' }),
        });
        Object.defineProperty(res, 'url', {
          value: 'https://example.com/missing',
        });
        return res;
      }),
    );
    const result = await executeTool('fetch_url', {
      url: 'https://example.com/missing',
    });
    expect(result.metadata.no_match).toBe(true);
    expect(result.metadata.fetch_url?.error).toMatch(/HTTP 404/);
    expect(result.formatted).toMatch(/^\[fetch_url error\]/);
  });

  it('error path: SSRF block surfaces as a tool_result error string', async () => {
    const result = await executeTool('fetch_url', {
      url: 'http://localhost/secret',
    });
    expect(result.metadata.no_match).toBe(true);
    expect(result.metadata.fetch_url?.error).toMatch(
      /URL not allowed for security reasons/,
    );
  });

  it('rejects fetch_url calls missing the url input', async () => {
    const result = await executeTool('fetch_url', {});
    expect(result.metadata.no_match).toBe(true);
    expect(result.formatted).toMatch(/Invalid input/);
  });
});
