// Unit tests for the per-query dispatcher and the failure-rate math.
// Both are extracted from the main eval runner for testability —
// dispatchQuery is pure (deps-as-parameters, no closure state) and
// computeFailureRate is pure math.
//
// Two locks-in worth flagging:
//   - Only assertion-type queries trigger the skip path. A future
//     refactor accidentally gating retrieval on the availability check
//     would break the "retrieval-type queries are NOT affected" test.
//   - The threshold denominator is `attempted = total - skipped`,
//     not `total`. Skipped queries are invisible to the gate so
//     dormant queries can't shield real failures by inflating the
//     denominator (or, conversely, trip the gate by being counted as
//     errors when they were never run).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import {
  dispatchQuery,
  computeFailureRate,
  computeCostUSD,
  applyStreamEvent,
  EndpointUnreachableError,
  isResponseSourceAvailable,
  FAILURE_RATE_THRESHOLD,
  type Query,
  type DispatchDeps,
  type StreamAccum,
  type UsageEvent,
} from './dispatch.js';
import { getSupabaseClient } from '../../api/_supabase.js';

// Builds a DispatchDeps with optional overrides. The default supabase
// is a minimal RPC stub that returns empty data, which keeps
// processRetrievalQuery's call path happy without a live DB.
function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const noopSupabase = {
    rpc: async () => ({ data: [], error: null }),
  } as unknown as ReturnType<typeof getSupabaseClient>;
  return {
    embedding: new Array(1024).fill(0),
    mode: 'three-tool',
    threshold: 0.3,
    rerank: false,
    supabase: noopSupabase,
    isResponseSourceAvailable: () => false,
    ...overrides,
  };
}

describe('dispatchQuery — assertion routing (D1 lock-in)', () => {
  it('routes assertion-type queries to skipped when response source unavailable', async () => {
    const q: Query = {
      id: 'ot-test',
      query: 'what is 55 times 65',
      result_type: 'assertion',
      category: 'off-topic',
      tags: ['off-topic'],
      assertions: [],
    };

    const outcome = await dispatchQuery(q, makeDeps());

    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.id).toBe('ot-test');
      expect(outcome.category).toBe('off-topic');
      expect(outcome.result_type).toBe('assertion');
      expect(outcome.reason).toBe('chat-endpoint-not-wired');
    }
  });

  it('does NOT skip retrieval-type queries when response source unavailable (operator-added lock-in)', async () => {
    // Locks in: the availability check gates assertion-type queries
    // ONLY. A future refactor that accidentally checks availability
    // for retrieval queries would break this test, which is the point.
    const q: Query = {
      id: 'Q-test',
      query: 'Tushar at DISCO',
      result_type: 'retrieval',
      category: 'rag-retrieval',
      target_source: 'experience',
      correct_chunks: [
        { source: 'experience', source_id: 'experience.md', chunk_index: 0 },
      ],
      tags: ['realistic'],
    };

    // isResponseSourceAvailable returns false (default) — should not
    // affect the routing of a retrieval query.
    const outcome = await dispatchQuery(q, makeDeps());

    expect(outcome.kind).toBe('retrieval');
  });

  it('routes the same assertion query to assertion (not skipped) when response source IS available', async () => {
    // Symmetric check: the gate is honored both ways. When the chat
    // endpoint is wired, the skip path doesn't fire — the query goes
    // through processAssertionQuery. processAssertionQuery itself
    // throws (the inner getResponseContext is still a stub), so the
    // outcome here is 'error', not 'skipped'. What matters for this
    // test is that 'skipped' is no longer the outcome.
    const q: Query = {
      id: 'ot-test',
      query: 'what is 55 times 65',
      result_type: 'assertion',
      category: 'off-topic',
      tags: ['off-topic'],
      assertions: [],
    };

    const outcome = await dispatchQuery(
      q,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    expect(outcome.kind).not.toBe('skipped');
  });
});

describe('computeFailureRate — threshold math (D3 lock-in)', () => {
  it('uses attempted (= total - skipped) as the denominator: 1 failed of 5 attempted trips the gate at 20%', () => {
    // Today's near-miss shape, scaled: 20 queries total, 15 dormant
    // (skipped), 1 actual failure. Old logic: 1/20 = 5% → passes.
    // New logic: 1/5 = 20% → fails. This test asserts the new logic.
    const result = computeFailureRate({ total: 20, skipped: 15, failed: 1 });

    expect(result.attempted).toBe(5);
    expect(result.rate).toBeCloseTo(0.2, 6);
    expect(result.shouldFail).toBe(true);
    expect(result.rate).toBeGreaterThan(FAILURE_RATE_THRESHOLD);
  });

  it('PR-B-shaped scenario passes the gate cleanly: 20 dormant + 49 attempted with 0 failures', () => {
    // Anticipated PR B shape: 15 new dormant queries (refusal + injection
    // + canary-leak categories) on top of today's 5 off-topic = 20 dormant
    // total. 44 labeled retrieval + 5 OOC = 49 attempted, all succeed.
    // Gate should pass cleanly because the skipped queries don't shield
    // failures (there are none) — but also don't trip the gate by being
    // counted as errors.
    const result = computeFailureRate({ total: 69, skipped: 20, failed: 0 });

    expect(result.attempted).toBe(49);
    expect(result.rate).toBe(0);
    expect(result.shouldFail).toBe(false);
  });

  it('real retrieval errors still count: 6 failures of 50 attempted (12%) trips the gate even with 0 skipped', () => {
    // Locks in: the new denominator doesn't accidentally shield real
    // failures. If 12% of attempted queries truly errored, the run
    // still fails — the skipped-adjustment only changes the
    // denominator when there are skipped queries to remove.
    const result = computeFailureRate({ total: 50, skipped: 0, failed: 6 });

    expect(result.attempted).toBe(50);
    expect(result.rate).toBeCloseTo(0.12, 6);
    expect(result.shouldFail).toBe(true);
  });

  it('all-skipped run does not trip the gate (attempted = 0 short-circuits)', () => {
    // Edge case: if every query was skipped (no chat endpoint, no
    // retrieval queries authored), attempted is 0 and the rate is
    // undefined. We treat 0/0 as 0 and explicitly never fail on it —
    // a run that ran nothing has nothing to fail.
    const result = computeFailureRate({ total: 5, skipped: 5, failed: 0 });

    expect(result.attempted).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.shouldFail).toBe(false);
  });

  it('exactly at the threshold does NOT trip (strict greater-than)', () => {
    // Documents the boundary: rate must EXCEED the threshold, not
    // just match it. 1/10 = 10% exactly with threshold 10% passes.
    const result = computeFailureRate({ total: 10, skipped: 0, failed: 1 });

    expect(result.rate).toBeCloseTo(FAILURE_RATE_THRESHOLD, 6);
    expect(result.shouldFail).toBe(false);
  });
});

// ============================================================================
// Phase 4a: chat-endpoint wiring tests
// ============================================================================

describe('isResponseSourceAvailable — env-var contract (Phase 4a)', () => {
  // Each test snapshots and restores the two env vars individually so
  // tests can run in any order without cross-contamination from a
  // local .env.local that has them set.
  let prevUrl: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevUrl = process.env.EVAL_CHAT_ENDPOINT_URL;
    prevSecret = process.env.EVAL_BYPASS_SECRET;
    delete process.env.EVAL_CHAT_ENDPOINT_URL;
    delete process.env.EVAL_BYPASS_SECRET;
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.EVAL_CHAT_ENDPOINT_URL;
    else process.env.EVAL_CHAT_ENDPOINT_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.EVAL_BYPASS_SECRET;
    else process.env.EVAL_BYPASS_SECRET = prevSecret;
  });

  it('returns false when both env vars are unset', () => {
    expect(isResponseSourceAvailable()).toBe(false);
  });

  it('returns false when only EVAL_CHAT_ENDPOINT_URL is set', () => {
    process.env.EVAL_CHAT_ENDPOINT_URL = 'https://example.com/api/chat';
    expect(isResponseSourceAvailable()).toBe(false);
  });

  it('returns false when only EVAL_BYPASS_SECRET is set', () => {
    process.env.EVAL_BYPASS_SECRET = 'secret';
    expect(isResponseSourceAvailable()).toBe(false);
  });

  it('returns false when either env var is empty string', () => {
    process.env.EVAL_CHAT_ENDPOINT_URL = '';
    process.env.EVAL_BYPASS_SECRET = 'secret';
    expect(isResponseSourceAvailable()).toBe(false);
    process.env.EVAL_CHAT_ENDPOINT_URL = 'https://example.com/api/chat';
    process.env.EVAL_BYPASS_SECRET = '';
    expect(isResponseSourceAvailable()).toBe(false);
  });

  it('returns true when both env vars are set and non-empty', () => {
    process.env.EVAL_CHAT_ENDPOINT_URL = 'https://example.com/api/chat';
    process.env.EVAL_BYPASS_SECRET = 'secret';
    expect(isResponseSourceAvailable()).toBe(true);
  });
});

describe('applyStreamEvent — NDJSON parser (Phase 4a)', () => {
  function emptyAccum(): StreamAccum {
    return {
      text: '',
      trace_id: null,
      rag_used: false,
      sources: [],
      usage: null,
    };
  }

  it('captures trace_id from a trace event', () => {
    const a = emptyAccum();
    applyStreamEvent(a, JSON.stringify({ type: 'trace', traceId: 'abc123' }));
    expect(a.trace_id).toBe('abc123');
  });

  it('accumulates delta text events into a single string', () => {
    const a = emptyAccum();
    applyStreamEvent(a, JSON.stringify({ type: 'delta', text: 'Hello' }));
    applyStreamEvent(a, JSON.stringify({ type: 'delta', text: ' world' }));
    expect(a.text).toBe('Hello world');
  });

  it('maps rag.sources string[] to CitedSource[]', () => {
    const a = emptyAccum();
    applyStreamEvent(
      a,
      JSON.stringify({
        type: 'rag',
        rag_used: true,
        sources: ['experience', 'readme'],
      }),
    );
    expect(a.rag_used).toBe(true);
    expect(a.sources).toEqual([{ source: 'experience' }, { source: 'readme' }]);
  });

  it('captures usage tokens + model from a usage event', () => {
    const a = emptyAccum();
    applyStreamEvent(
      a,
      JSON.stringify({
        type: 'usage',
        input_tokens: 120,
        output_tokens: 45,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3500,
        model: 'claude-sonnet-4-6',
      }),
    );
    expect(a.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3500,
      model: 'claude-sonnet-4-6',
    });
  });

  it('ignores malformed JSON lines silently (defensive)', () => {
    const a = emptyAccum();
    applyStreamEvent(a, 'not valid json');
    applyStreamEvent(a, '{"incomplete":');
    expect(a).toEqual(emptyAccum());
  });

  it('ignores blank lines and unknown event types', () => {
    const a = emptyAccum();
    applyStreamEvent(a, '');
    applyStreamEvent(a, '   ');
    applyStreamEvent(a, JSON.stringify({ type: 'future-event-type' }));
    applyStreamEvent(a, JSON.stringify({ type: 'done' }));
    expect(a).toEqual(emptyAccum());
  });

  it('throws on an error event so the dispatcher can map to kind:error', () => {
    const a = emptyAccum();
    expect(() =>
      applyStreamEvent(
        a,
        JSON.stringify({ type: 'error', message: 'upstream blew up' }),
      ),
    ).toThrow(/upstream blew up/);
  });
});

describe('computeCostUSD — Phase 4a price table', () => {
  it('returns null when usage is null', () => {
    expect(computeCostUSD(null)).toBeNull();
  });

  it('returns null when model is missing', () => {
    const u: UsageEvent = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: null,
    };
    expect(computeCostUSD(u)).toBeNull();
  });

  it('returns null when model is not in the price table (soft degradation)', () => {
    const u: UsageEvent = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: 'claude-opus-99-9',
    };
    expect(computeCostUSD(u)).toBeNull();
  });

  it('multiplies all four token buckets correctly against Sonnet 4.6 pricing', () => {
    const u: UsageEvent = {
      input_tokens: 1_000_000, // $3.00
      output_tokens: 1_000_000, // $15.00
      cache_creation_input_tokens: 1_000_000, // $3.75
      cache_read_input_tokens: 1_000_000, // $0.30
      model: 'claude-sonnet-4-6',
    };
    // Sum = 3 + 15 + 3.75 + 0.30 = 22.05
    expect(computeCostUSD(u)).toBeCloseTo(22.05, 6);
  });

  it('matches by prefix so dated model ids like claude-sonnet-4-6-20251022 work', () => {
    const u: UsageEvent = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: 'claude-sonnet-4-6-20251022',
    };
    expect(computeCostUSD(u)).toBeCloseTo(3.0, 6);
  });

  it('handles realistic small-query usage (representative of an eval turn)', () => {
    const u: UsageEvent = {
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3500,
      model: 'claude-sonnet-4-6',
    };
    // 120 * 3/M + 45 * 15/M + 0 + 3500 * 0.3/M
    // = 0.00036 + 0.000675 + 0 + 0.00105 = 0.002085
    expect(computeCostUSD(u)).toBeCloseTo(0.002085, 6);
  });
});

describe('dispatchQuery — getResponseContext wired to fetch (Phase 4a)', () => {
  // The mocked-fetch tests construct a synthesized Response whose body
  // is a ReadableStream emitting the chat endpoint's NDJSON shape.
  // The runner code shouldn't care that fetch is mocked.
  let prevUrl: string | undefined;
  let prevSecret: string | undefined;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    prevUrl = process.env.EVAL_CHAT_ENDPOINT_URL;
    prevSecret = process.env.EVAL_BYPASS_SECRET;
    process.env.EVAL_CHAT_ENDPOINT_URL = 'https://example.com/api/chat';
    process.env.EVAL_BYPASS_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.EVAL_CHAT_ENDPOINT_URL;
    else process.env.EVAL_CHAT_ENDPOINT_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.EVAL_BYPASS_SECRET;
    else process.env.EVAL_BYPASS_SECRET = prevSecret;
    globalThis.fetch = origFetch;
  });

  function ndjsonStream(events: object[]): ReadableStream<Uint8Array> {
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const bytes = new TextEncoder().encode(body);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  const assertionQuery: Query = {
    id: 'ref-001',
    query: "what's your favorite color?",
    result_type: 'assertion',
    category: 'refusal',
    tags: ['refusal'],
    assertions: [{ type: 'rag_used', expected: false }],
  };

  function makeFetchMock(
    stream: ReadableStream<Uint8Array>,
    ok = true,
  ): typeof fetch {
    return vi.fn(
      async () =>
        new Response(stream, {
          status: ok ? 200 : 500,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    ) as unknown as typeof fetch;
  }

  it('parses a normal-flow response into an assertion outcome with trace/cost/latency', async () => {
    globalThis.fetch = makeFetchMock(
      ndjsonStream([
        { type: 'trace', traceId: 'trace-xyz' },
        { type: 'delta', text: '¯\\_(ツ)_/¯' },
        { type: 'delta', text: ' no strong opinion.' },
        { type: 'rag', rag_used: false, sources: [] },
        {
          type: 'usage',
          input_tokens: 120,
          output_tokens: 45,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 3500,
          model: 'claude-sonnet-4-6',
        },
        { type: 'done' },
      ]),
    );

    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    expect(outcome.kind).toBe('assertion');
    if (outcome.kind !== 'assertion') return;
    expect(outcome.responseText).toBe('¯\\_(ツ)_/¯ no strong opinion.');
    expect(outcome.traceId).toBe('trace-xyz');
    expect(outcome.costUsd).toBeCloseTo(0.002085, 6);
    expect(outcome.latencySeconds).not.toBeNull();
    expect(outcome.latencySeconds! >= 0).toBe(true);
  });

  it('classifies ENOTFOUND as kind:skipped reason:endpoint-unreachable (deploy outage)', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err: NodeJS.ErrnoException = Object.assign(
        new Error('getaddrinfo ENOTFOUND'),
        { code: 'ENOTFOUND' },
      );
      throw err;
    }) as unknown as typeof fetch;

    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('endpoint-unreachable');
    }
  });

  it('classifies ECONNREFUSED at err.cause.code as kind:skipped reason:endpoint-unreachable', async () => {
    // Node fetch wraps TCP errors as `cause` on a generic "fetch failed" Error.
    globalThis.fetch = vi.fn(async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const err = new Error('fetch failed');
      (err as { cause?: unknown }).cause = cause;
      throw err;
    }) as unknown as typeof fetch;

    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('endpoint-unreachable');
    }
  });

  it('classifies HTTP 5xx as kind:error (server issue worth flagging)', async () => {
    globalThis.fetch = makeFetchMock(ndjsonStream([]), false);

    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/HTTP 500/);
    }
  });

  it('classifies a stream error-event as kind:error', async () => {
    globalThis.fetch = makeFetchMock(
      ndjsonStream([
        { type: 'trace', traceId: 't' },
        { type: 'error', message: 'upstream lost' },
        { type: 'done' },
      ]),
    );
    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/upstream lost/);
    }
  });

  it('classifies malformed NDJSON gracefully — parser skips, returns whatever surfaced', async () => {
    // Malformed lines are skipped by applyStreamEvent. With only
    // garbage and a done sentinel, the response is empty but not an
    // error.
    globalThis.fetch = makeFetchMock(
      ndjsonStream([
        { type: 'trace', traceId: 't' },
        // simulate a malformed line by inserting a non-object — the
        // ndjsonStream helper stringifies everything, so this still
        // produces valid JSON. For a true malformed test, use the
        // applyStreamEvent unit test (covered above).
        { type: 'done' },
      ]),
    );
    const outcome = await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );
    expect(outcome.kind).toBe('assertion');
  });

  it('sends the bypass header + trace headers in the fetch request', async () => {
    const stream = ndjsonStream([
      { type: 'trace', traceId: 'trace-xyz' },
      { type: 'rag', rag_used: false, sources: [] },
      {
        type: 'usage',
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        model: null,
      },
      { type: 'done' },
    ]);
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/chat');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-eval-bypass']).toBe('test-secret');
    expect(headers['x-trace-source']).toBe('eval');
    expect(headers['x-eval-query-id']).toBe('ref-001');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      q: "what's your favorite color?",
    });
  });
});

describe('EndpointUnreachableError', () => {
  it('is identifiable via instanceof', () => {
    const err = new EndpointUnreachableError('ENOTFOUND');
    expect(err).toBeInstanceOf(EndpointUnreachableError);
    expect(err.reason).toBe('ENOTFOUND');
    expect(err.name).toBe('EndpointUnreachableError');
  });
});

describe('dispatchQuery — Vercel automation-bypass header (Phase 4b)', () => {
  // Locks in: VERCEL_AUTOMATION_BYPASS_SECRET → x-vercel-protection-bypass
  // header is forwarded on the dispatch fetch. Absent env var → header
  // omitted (preview-protection-disabled default; behavior identical to
  // pre-Phase-4b).
  let prevUrl: string | undefined;
  let prevSecret: string | undefined;
  let prevVercel: string | undefined;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    prevUrl = process.env.EVAL_CHAT_ENDPOINT_URL;
    prevSecret = process.env.EVAL_BYPASS_SECRET;
    prevVercel = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    process.env.EVAL_CHAT_ENDPOINT_URL = 'https://example.com/api/chat';
    process.env.EVAL_BYPASS_SECRET = 'test-secret';
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.EVAL_CHAT_ENDPOINT_URL;
    else process.env.EVAL_CHAT_ENDPOINT_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.EVAL_BYPASS_SECRET;
    else process.env.EVAL_BYPASS_SECRET = prevSecret;
    if (prevVercel === undefined)
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = prevVercel;
    globalThis.fetch = origFetch;
  });

  function ndjsonStream(events: object[]): ReadableStream<Uint8Array> {
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const bytes = new TextEncoder().encode(body);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(
      async () =>
        new Response(
          ndjsonStream([
            { type: 'trace', traceId: 't' },
            { type: 'rag', rag_used: false, sources: [] },
            {
              type: 'usage',
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              model: null,
            },
            { type: 'done' },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          },
        ),
    );
  }

  const assertionQuery: Query = {
    id: 'ref-001',
    query: 'q',
    result_type: 'assertion',
    category: 'refusal',
    tags: ['refusal'],
    assertions: [{ type: 'rag_used', expected: false }],
  };

  it('forwards x-vercel-protection-bypass when VERCEL_AUTOMATION_BYPASS_SECRET is set', async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'vercel-secret';
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-vercel-protection-bypass']).toBe('vercel-secret');
    // Existing headers still in place — bypass is additive, not a replace.
    expect(headers['x-eval-bypass']).toBe('test-secret');
  });

  it('omits x-vercel-protection-bypass when VERCEL_AUTOMATION_BYPASS_SECRET is unset', async () => {
    // beforeEach already deletes the var; confirms today's default (preview
    // protection disabled) sends no bypass header — behavior unchanged.
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await dispatchQuery(
      assertionQuery,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-vercel-protection-bypass']).toBeUndefined();
    expect(headers['x-eval-bypass']).toBe('test-secret');
  });
});
