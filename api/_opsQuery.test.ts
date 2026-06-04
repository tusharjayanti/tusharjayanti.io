// Unit tests for the canonical ops read layer. All HTTP is mocked at
// the fetch boundary via vi.stubGlobal — no live Langfuse hits. The
// 429-backoff test uses fake timers so the 2s/5s/15s sleeps don't
// actually elapse.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  opsQuery,
  opsObservations,
  realUser,
  type OpsTrace,
} from './_opsQuery.js';

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

// A page of `n` traces, each with the given tags. `meta` is omitted so
// the loop falls back to the short-page heuristic (items < PAGE_LIMIT).
function tracePage(n: number, tags: string[] = []) {
  return {
    data: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      name: 'chat-turn',
      timestamp: '2026-05-20T00:00:00Z',
      tags,
      totalCost: 0.01,
    })),
  };
}

describe('opsQuery', () => {
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

  it('throws when Langfuse credentials are missing', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    await expect(opsQuery({ windowDays: 7 })).rejects.toThrow(
      /LANGFUSE_PUBLIC_KEY/,
    );
  });

  it('hits /api/public/traces filtered by name=chat-turn with a window', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(tracePage(3));
      }),
    );
    const res = await opsQuery({
      windowDays: 7,
      now: new Date('2026-05-22T00:00:00Z'),
    });
    expect(res.count).toBe(3);
    expect(res.traces).toHaveLength(3);
    expect(calls[0]).toContain('/api/public/traces');
    expect(calls[0]).toContain('name=chat-turn');
    expect(calls[0]).toContain('fromTimestamp=2026-05-15'); // 7d before the 22nd
    expect(calls[0]).toContain('toTimestamp=2026-05-22');
  });

  it('paginates: a full page triggers a second fetch, a short page stops it', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        // page 1 is full (100) → loop continues; page 2 is short → stop.
        return jsonResponse(call === 1 ? tracePage(100) : tracePage(2));
      }),
    );
    const res = await opsQuery({ windowDays: 7, includeEvals: true });
    expect(res.count).toBe(102);
    expect(call).toBe(2);
  });

  it('respects meta.totalPages when present', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse({ ...tracePage(100), meta: { totalPages: 2 } });
      }),
    );
    const res = await opsQuery({ windowDays: 7, includeEvals: true });
    // Two full pages, stopped by totalPages=2 rather than a short page.
    expect(res.count).toBe(200);
    expect(call).toBe(2);
  });

  it('excludes eval-source by default and includes it when includeEvals=true', async () => {
    // One page: 2 real + 3 eval-source traces.
    const mixed = {
      data: [
        { id: 'r1', name: 'chat-turn', timestamp: 't', tags: [] },
        { id: 'r2', name: 'chat-turn', timestamp: 't', tags: ['grounded'] },
        { id: 'e1', name: 'chat-turn', timestamp: 't', tags: ['eval-source'] },
        { id: 'e2', name: 'chat-turn', timestamp: 't', tags: ['eval-source'] },
        {
          id: 'e3',
          name: 'chat-turn',
          timestamp: 't',
          tags: ['eval-source', 'grounded'],
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(mixed)),
    );

    const excluded = await opsQuery({ windowDays: 7 }); // default false
    expect(excluded.count).toBe(2);
    expect(excluded.traces.map((t) => t.id)).toEqual(['r1', 'r2']);

    const included = await opsQuery({ windowDays: 7, includeEvals: true });
    expect(included.count).toBe(5);
  });

  it('normalizes null tags to [] and missing totalCost to 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: 'x', name: 'chat-turn', timestamp: 't', tags: null }],
        }),
      ),
    );
    const res = await opsQuery({ windowDays: 7 });
    expect(res.traces[0].tags).toEqual([]);
    expect(res.traces[0].totalCost).toBe(0);
  });

  it('throws (does not truncate) when the window exceeds the 2000-trace cap', async () => {
    // Every page is full (100) and carries no meta → the loop never sees a
    // short page and runs past MAX_PAGES (20). Must throw, not return 2000.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse(tracePage(100));
      }),
    );
    await expect(
      opsQuery({ windowDays: 7, includeEvals: true }),
    ).rejects.toThrow(/cap/);
    expect(call).toBe(20); // exactly MAX_PAGES fetches, then throw
  });

  it('retries on 429 with backoff and then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(tracePage(1)));
    vi.stubGlobal('fetch', fetchMock);

    const p = opsQuery({ windowDays: 7 });
    // Flush the 2s then 5s backoff sleeps without real waiting.
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after exhausting 429 retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = opsQuery({ windowDays: 7 });
    const assertion = expect(p).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial + 3 backoff attempts (BACKOFF_MS has 3 entries).
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('never exceeds the global concurrency cap under a flood', async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 5)); // hold the slot briefly
        inflight -= 1;
        return jsonResponse(tracePage(3)); // short page → 1 fetch per query
      }),
    );
    // 12 single-page queries fired at once; the limiter must keep at most
    // MAX_CONCURRENT_LANGFUSE (3) fetches in flight at any instant.
    await Promise.all(
      Array.from({ length: 12 }, () => opsQuery({ windowDays: 7 })),
    );
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBeGreaterThan(1); // sanity: it is concurrent, just capped
  });

  it('fetches pages 2..N in parallel and preserves page order', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls += 1;
        const page = Number(new URL(url).searchParams.get('page'));
        return jsonResponse({
          data: [
            { id: `p${page}-a`, name: 'chat-turn', timestamp: 't', tags: [] },
            { id: `p${page}-b`, name: 'chat-turn', timestamp: 't', tags: [] },
          ],
          meta: { totalPages: 3 },
        });
      }),
    );
    const res = await opsQuery({ windowDays: 7, includeEvals: true });
    // Assembly order matches serial even though 2 + 3 fetch concurrently.
    expect(res.traces.map((t) => t.id)).toEqual([
      'p1-a',
      'p1-b',
      'p2-a',
      'p2-b',
      'p3-a',
      'p3-b',
    ]);
    expect(calls).toBe(3); // page 1, then pages 2 + 3
  });

  it('throws up-front when meta.totalPages exceeds the cap (fetches only page 1)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ ...tracePage(100), meta: { totalPages: 25 } });
      }),
    );
    await expect(
      opsQuery({ windowDays: 7, includeEvals: true }),
    ).rejects.toThrow(/cap/);
    expect(calls).toBe(1); // cap-guarded before fetching pages 2..25
  });
});

describe('opsObservations', () => {
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
    process.env.LANGFUSE_PUBLIC_KEY = originalEnv.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = originalEnv.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = originalEnv.LANGFUSE_BASE_URL;
  });

  it('hits /api/public/observations?type=GENERATION and normalizes', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [
            {
              id: 'o1',
              traceId: 't1',
              name: 'anthropic_first_call',
              model: 'claude-sonnet-4-6',
              calculatedTotalCost: 0.012,
              latency: 1.8,
              startTime: '2026-05-20T00:00:00Z',
            },
            // missing fields normalize to '' / 0
            { id: 'o2', traceId: 't2' },
          ],
        });
      }),
    );
    const obs = await opsObservations({ windowDays: 7 });
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({
      traceId: 't1',
      model: 'claude-sonnet-4-6',
      calculatedTotalCost: 0.012,
    });
    expect(obs[1]).toMatchObject({
      name: '',
      model: '',
      calculatedTotalCost: 0,
    });
    expect(calls[0]).toContain('/api/public/observations');
    expect(calls[0]).toContain('type=GENERATION');
  });
});

describe('realUser', () => {
  const trace = (id: string, tags: string[]): OpsTrace => ({
    id,
    name: 'chat-turn',
    timestamp: '2026-05-20T00:00:00Z',
    tags,
    totalCost: 0.01,
    latency: 1.5,
  });

  it('drops injection-detected / rate-limited / streamed-error traces', () => {
    const traces = [
      trace('clean', []),
      trace('grounded', ['grounded']),
      trace('inj', ['injection-detected']),
      trace('rl', ['rate-limited']),
      trace('err', ['streamed-error']),
      trace('multi', ['grounded', 'streamed-error']),
    ];
    const kept = realUser(traces);
    expect(kept.map((t) => t.id)).toEqual(['clean', 'grounded']);
  });

  it('does NOT drop eval-source (that axis belongs to opsQuery)', () => {
    const traces = [trace('e', ['eval-source']), trace('c', [])];
    expect(realUser(traces).map((t) => t.id)).toEqual(['e', 'c']);
  });

  it('returns everything when no trace carries a defense tag', () => {
    const traces = [trace('a', []), trace('b', ['grounded'])];
    expect(realUser(traces)).toHaveLength(2);
  });
});
