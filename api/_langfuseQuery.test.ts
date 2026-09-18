// Unit tests for the Langfuse REST aggregator. All HTTP calls are
// mocked via vi.stubGlobal('fetch', ...) — no live Langfuse hits.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { makeLangfuseAggregate } from './_langfuseQuery.js';

const ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
  LANGFUSE_BASE_URL: 'https://example.langfuse.test',
};

// A ROOT observation row in the v2 shape. Trace-level fields (traceName,
// tags) live on the row whose parentObservationId is null; the read layer
// groups rows by traceId and reconstructs the trace from it.
function rootRow(id: string, tags: string[] = []) {
  return {
    id: `obs-${id}`,
    traceId: id,
    parentObservationId: null,
    type: 'SPAN',
    name: 'chat-turn',
    traceName: 'chat-turn',
    startTime: '2026-05-20T00:00:00Z',
    endTime: '2026-05-20T00:00:01Z',
    tags,
    totalCost: 0,
    latency: 1,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('makeLangfuseAggregate', () => {
  const originalEnv = {
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
  };

  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = ENV.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = ENV.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = ENV.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env.LANGFUSE_PUBLIC_KEY = originalEnv.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = originalEnv.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = originalEnv.LANGFUSE_BASE_URL;
  });

  it('returns null when env vars are missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(makeLangfuseAggregate()).toBeNull();
  });

  it('sumTokens hits /v2/observations?type=GENERATION (not a trace endpoint)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/api/public/v2/observations')) {
          return jsonResponse({
            data: [
              { id: 'o1', totalTokens: 1915, usage: { total: 1915 } },
              { id: 'o2', totalTokens: 392, usage: { total: 392 } },
              { id: 'o3', totalTokens: 1058 },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const lf = makeLangfuseAggregate();
    expect(lf).not.toBeNull();
    const total = await lf!.sumTokens(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBe(1915 + 392 + 1058);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/public/v2/observations');
    expect(calls[0]).toContain('type=GENERATION');
    // Token aggregation must NOT be routed through the traces endpoint.
    expect(calls[0]).not.toContain('/api/public/traces');
  });

  it('sumTokens falls back to usage.total when totalTokens is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: 'o1', usage: { total: 500 } },
            { id: 'o2', totalTokens: 200 },
            { id: 'o3' /* no usage field at all */ },
          ],
        }),
      ),
    );
    const lf = makeLangfuseAggregate()!;
    const total = await lf.sumTokens(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBe(700);
  });

  it('countTraces routes through the canonical ops read layer (/v2/observations)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [rootRow('t1'), rootRow('t2'), rootRow('t3')],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(count).toBe(3);
    expect(calls[0]).toContain('/api/public/v2/observations');
    expect(calls[0]).toContain('limit=1000');
  });

  it('countGroundedTraces filters on the ROOT observation tags', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [
            rootRow('t1', ['grounded']),
            rootRow('t2', ['grounded']),
            // Not grounded — must be excluded by the client-side root-tag
            // filter that replaces v1's server-side `tags=` param.
            rootRow('t3', []),
          ],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countGroundedTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
      'grounded',
    );
    expect(count).toBe(2);
    expect(calls[0]).toContain('/api/public/v2/observations');
  });

  it('countGroundedTraces follows the v2 cursor across pages', async () => {
    // Page 1 returns a cursor so the loop continues; page 2 returns none.
    // In v2 a full page is NOT a continue signal — only a cursor is.
    const firstPage = {
      data: Array.from({ length: 100 }, (_, i) =>
        rootRow(`t${i}`, ['grounded']),
      ),
      meta: { cursor: 'CUR1' },
    };
    const lastPage = {
      data: [rootRow('tail1', ['grounded']), rootRow('tail2', ['grounded'])],
    };
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse(call === 1 ? firstPage : lastPage);
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countGroundedTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
      'grounded',
    );
    expect(count).toBe(102);
    expect(call).toBe(2);
  });

  it('sumCost sums calculatedTotalCost across generations and treats missing/null as 0', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [
            { id: 'o1', calculatedTotalCost: 0.0106 },
            { id: 'o2', calculatedTotalCost: 0.0009 },
            { id: 'o3', calculatedTotalCost: 0 }, // Voyage embedding
            { id: 'o4' /* no cost field at all */ },
            { id: 'o5', calculatedTotalCost: null },
          ],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const total = await lf.sumCost(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBeCloseTo(0.0115, 6);
    expect(calls[0]).toContain('/api/public/v2/observations');
    expect(calls[0]).toContain('type=GENERATION');
  });

  it('sumCost paginates across pages', async () => {
    const fullPage = {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: `o${i}`,
        totalCost: 0.01,
      })),
      meta: { cursor: 'CUR1' },
    };
    const lastPage = { data: [{ id: 'tail', totalCost: 0.5 }] };
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse(call === 1 ? fullPage : lastPage);
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const total = await lf.sumCost(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBeCloseTo(1.5, 6);
    expect(call).toBe(2);
  });

  it('caches each metric so concurrent calls share one HTTP request', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('type=GENERATION')) {
        return jsonResponse({ data: [{ id: 'o1', totalTokens: 100 }] });
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const lf = makeLangfuseAggregate()!;
    const [a, b] = await Promise.all([
      lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
      lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
    ]);
    expect(a).toBe(100);
    expect(b).toBe(100);
    // Only one fetch fired across two calls — the second await
    // resolved the cached promise.
    const generationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('type=GENERATION'),
    );
    expect(generationCalls).toHaveLength(1);
  });

  // The HUD regression that prompted the merge: tokens and cost used to
  // drive two byte-identical observation paginations, doubling the
  // request burst that tripped Langfuse's rate limit. They must now share
  // ONE pass over the GENERATION endpoint.
  it('sumTokens + sumCost share ONE observation pagination', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      jsonResponse({
        data: [{ id: 'o1', totalTokens: 100, calculatedTotalCost: 0.01 }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const lf = makeLangfuseAggregate()!;
    const [tokens, cost] = await Promise.all([
      lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
      lf.sumCost('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
    ]);
    expect(tokens).toBe(100);
    expect(cost).toBeCloseTo(0.01, 6);
    const obsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/public/v2/observations'),
    );
    expect(obsCalls).toHaveLength(1);
  });

  it('retries on a transient 429 and then succeeds', async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return new Response('rate limited', { status: 429 });
        return jsonResponse({
          data: [{ id: 'o1', totalTokens: 100, calculatedTotalCost: 0.01 }],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const p = lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z');
    await vi.runAllTimersAsync();
    expect(await p).toBe(100);
    expect(call).toBe(2);
  });

  it('honors a Retry-After header before retrying', async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response('', {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }
        return jsonResponse({ data: [] });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    // Retry-After is honored by THIS module's langfuseGet, which now backs
    // only the observation sums; the trace counts delegate to
    // api/_opsQuery.ts and use its jittered backoff instead.
    const p = lf.sumCost('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z');
    // Not yet retried — the 1s Retry-After delay hasn't elapsed.
    await vi.advanceTimersByTimeAsync(999);
    expect(call).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(0);
    expect(call).toBe(2);
  });

  it('throws after exhausting retries on a persistent 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const lf = makeLangfuseAggregate()!;
    const p = lf.sumCost('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z');
    const assertion = expect(p).rejects.toThrow(/returned 429/);
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial attempt + 3 backoff retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
