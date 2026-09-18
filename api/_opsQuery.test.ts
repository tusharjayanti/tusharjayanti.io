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

// One ROOT observation row per trace, in the v2 shape. v4 is
// observations-first: a "trace" is the group of rows sharing a traceId,
// with trace-level fields read off the row whose parentObservationId is
// null. `meta` omitted => no cursor => single page.
function rootRow(
  id: string,
  tags: string[] = [],
  extra: Record<string, unknown> = {},
) {
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
    totalCost: 0.01,
    latency: 1,
    ...extra,
  };
}

function tracePage(n: number, tags: string[] = [], cursor?: string) {
  return {
    data: Array.from({ length: n }, (_, i) => rootRow(`t${i}`, tags)),
    ...(cursor ? { meta: { cursor } } : {}),
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

  it('hits /v2/observations with a time-bounded window and field groups', async () => {
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
    expect(calls[0]).toContain('/api/public/v2/observations');
    expect(calls[0]).toContain('limit=1000');
    expect(calls[0]).toContain('fromStartTime=2026-05-15'); // 7d before the 22nd
    expect(calls[0]).toContain('toStartTime=2026-05-22');
    // v2 omits any field group not asked for; the trace list needs io +
    // trace_context (tags) + metadata (rag_*).
    expect(decodeURIComponent(calls[0])).toContain(
      'fields=core,basic,io,trace_context,metadata',
    );
  });

  it('follows meta.cursor serially until the cursor is absent', async () => {
    const calls: string[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        call += 1;
        // Page 1 returns a cursor; page 2 returns none => stop.
        return jsonResponse(
          call === 1
            ? { data: [rootRow('a')], meta: { cursor: 'CUR1' } }
            : { data: [rootRow('b')] },
        );
      }),
    );
    const res = await opsQuery({ windowDays: 7, includeEvals: true });
    expect(res.count).toBe(2);
    expect(call).toBe(2);
    // The second request must carry the cursor from the first response —
    // this is what makes v2 pagination serial.
    expect(calls[0]).not.toContain('cursor=');
    expect(calls[1]).toContain('cursor=CUR1');
  });

  it('stops after a single request when no cursor is returned', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse(tracePage(100));
      }),
    );
    const res = await opsQuery({ windowDays: 7, includeEvals: true });
    // A full page is NOT a signal to continue in v2; only a cursor is.
    expect(res.count).toBe(100);
    expect(call).toBe(1);
  });

  it('excludes eval-source by default and includes it when includeEvals=true', async () => {
    // One page: 2 real + 3 eval-source traces.
    const mixed = {
      data: [
        rootRow('r1', []),
        rootRow('r2', ['grounded']),
        rootRow('e1', ['eval-source']),
        rootRow('e2', ['eval-source']),
        rootRow('e3', ['eval-source', 'grounded']),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(mixed)),
    );

    const excluded = await opsQuery({ windowDays: 7 }); // default false
    expect(excluded.count).toBe(2);
    expect(excluded.traces.map((t) => t.id).sort()).toEqual(['r1', 'r2']);

    const included = await opsQuery({ windowDays: 7, includeEvals: true });
    expect(included.count).toBe(5);
  });

  it('normalizes null tags to [] and missing totalCost to 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [rootRow('x', [], { tags: null, totalCost: null })],
        }),
      ),
    );
    const res = await opsQuery({ windowDays: 7 });
    expect(res.traces[0].tags).toEqual([]);
    expect(res.traces[0].totalCost).toBe(0);
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

  it('hits /v2/observations?type=GENERATION and normalizes totalCost', async () => {
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
              totalCost: 0.012,
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
    expect(calls[0]).toContain('/api/public/v2/observations');
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
