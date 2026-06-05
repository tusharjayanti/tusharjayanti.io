// Unit tests for the Langfuse REST aggregator. All HTTP calls are
// mocked via vi.stubGlobal('fetch', ...) — no live Langfuse hits.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { makeLangfuseAggregate } from './_langfuseQuery.js';

const ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
  LANGFUSE_BASE_URL: 'https://example.langfuse.test',
};

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

  it('sumTokens hits /api/public/observations?type=GENERATION (not the traces endpoint)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/api/public/observations')) {
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
    expect(calls[0]).toContain('/api/public/observations');
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

  it('countTraces hits /api/public/traces filtered by name=chat-turn', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(count).toBe(3);
    expect(calls[0]).toContain('/api/public/traces');
    expect(calls[0]).toContain('name=chat-turn');
  });

  it('countGroundedTraces hits /api/public/traces with name=chat-turn and the tag filter', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({ data: [{ id: 't1' }, { id: 't2' }] });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countGroundedTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
      'grounded',
    );
    expect(count).toBe(2);
    expect(calls[0]).toContain('/api/public/traces');
    expect(calls[0]).toContain('name=chat-turn');
    expect(calls[0]).toContain('tags=grounded');
  });

  it('countGroundedTraces paginates and sums counts across pages', async () => {
    // First page returns a full PAGE_LIMIT (100) so the loop fetches a
    // second page; the short second page stops it.
    const fullPage = {
      data: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })),
    };
    const lastPage = { data: [{ id: 'tail1' }, { id: 'tail2' }] };
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse(call === 1 ? fullPage : lastPage);
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
    expect(calls[0]).toContain('/api/public/observations');
    expect(calls[0]).toContain('type=GENERATION');
  });

  it('sumCost paginates across pages', async () => {
    const fullPage = {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: `o${i}`,
        calculatedTotalCost: 0.01,
      })),
    };
    const lastPage = { data: [{ id: 'tail', calculatedTotalCost: 0.5 }] };
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
      String(url).includes('/api/public/observations'),
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
    const p = lf.countGroundedTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
      'grounded',
    );
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
