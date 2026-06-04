// Tests for the shared raw window cache + single-flight (STEP 3). The four
// rollup endpoints all derive from getWindowRaw, so a concurrent cold load
// must collapse to ONE Langfuse sweep; the eval toggle then filters on top.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getWindowRaw,
  applyEvalScope,
  realUser,
  type RawWindowCache,
  type WindowRaw,
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

// A cold Upstash mock: get always misses, set records the write.
function coldRedis() {
  const set = vi.fn(async () => 'OK');
  const redis = {
    get: vi.fn(async () => null),
    set,
  } as unknown as RawWindowCache;
  return { redis, set };
}

describe('getWindowRaw', () => {
  const originalEnv = { ...process.env };

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

  it('coalesces a concurrent cold load into ONE Langfuse sweep', async () => {
    let traceFetches = 0;
    let obsFetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/public/traces')) {
          traceFetches += 1;
          return jsonResponse({
            data: [
              { id: 'r1', name: 'chat-turn', timestamp: 't', tags: [] },
              {
                id: 'e1',
                name: 'chat-turn',
                timestamp: 't',
                tags: ['eval-source'],
              },
            ],
          });
        }
        if (url.includes('/api/public/observations')) {
          obsFetches += 1;
          return jsonResponse({ data: [] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { redis, set } = coldRedis();
    // Four concurrent callers = the four cold endpoints landing together.
    const results = await Promise.all([
      getWindowRaw(redis, 7),
      getWindowRaw(redis, 7),
      getWindowRaw(redis, 7),
      getWindowRaw(redis, 7),
    ]);

    // One sweep total, despite four callers.
    expect(traceFetches).toBe(1);
    expect(obsFetches).toBe(1);
    expect(set).toHaveBeenCalledTimes(1); // only the leader writes the blob
    // Raw is UNFILTERED (eval-source included) so both toggle states share it.
    expect(results[0].traces.map((t) => t.id)).toEqual(['r1', 'e1']);
    // All callers got the same object.
    for (const r of results) expect(r).toBe(results[0]);
  });

  it('serves the warm Upstash blob without re-fetching', async () => {
    const cached: WindowRaw = {
      traces: [
        {
          id: 'r1',
          name: 'chat-turn',
          timestamp: 't',
          tags: [],
          totalCost: 0,
          latency: 1,
          metadata: {},
          input: null,
          output: null,
          htmlPath: null,
          projectId: null,
          scores: [],
        },
      ],
      observations: [],
    };
    const redis = {
      get: vi.fn(async () => cached),
      set: vi.fn(async () => 'OK'),
    } as unknown as RawWindowCache;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('should not fetch on a warm blob');
      }),
    );
    const data = await getWindowRaw(redis, 7);
    expect(data).toBe(cached);
  });
});

describe('applyEvalScope (toggle filters from shared raw)', () => {
  const t = (id: string, tags: string[]) => ({ id, tags });

  it('drops eval-source by default and keeps it when includeEvals', () => {
    const traces = [
      t('r1', []),
      t('e1', ['eval-source']),
      t('r2', ['grounded']),
    ];
    expect(applyEvalScope(traces, false).map((x) => x.id)).toEqual([
      'r1',
      'r2',
    ]);
    expect(applyEvalScope(traces, true)).toHaveLength(3);
  });

  it('composes with realUser for the real-human scope', () => {
    const traces = [
      t('r1', []),
      t('e1', ['eval-source']),
      t('inj', ['injection-detected']),
    ];
    // includeEvals:false then realUser => only the clean human turn.
    expect(realUser(applyEvalScope(traces, false)).map((x) => x.id)).toEqual([
      'r1',
    ]);
  });
});
