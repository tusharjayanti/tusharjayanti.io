// Tests for the M2.8 ops snippet aggregation + cache logic.
// All Redis + Langfuse calls are mocked — no live API.

import { describe, it, expect, vi } from 'vitest';
import {
  LOCK_KEY,
  OFFLINE_SNIPPET,
  SNIPPET_KEY,
  aggregate,
  getOpsSnippet,
  sumVisitorsLast7Days,
  type LangfuseAggregateFns,
  type OpsSnippet,
  type SnippetRedis,
} from './_opsSnippet.js';

function makeRedis(overrides: Partial<SnippetRedis> = {}): SnippetRedis & {
  _store: Map<string, unknown>;
  _hashes: Map<string, number>;
} {
  const store = new Map<string, unknown>();
  const hashes = new Map<string, number>();
  return {
    _store: store,
    _hashes: hashes,
    get: async <T,>(key: string) => (store.get(key) as T) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      store.delete(key);
      return 1;
    },
    hlen: async (key) => hashes.get(key) ?? 0,
    ...overrides,
  } as SnippetRedis & {
    _store: Map<string, unknown>;
    _hashes: Map<string, number>;
  };
}

function makeLangfuse(
  values: Partial<{ traces: number; tokens: number; tools: number }> = {},
): LangfuseAggregateFns & {
  countTraces: ReturnType<typeof vi.fn>;
  sumTokens: ReturnType<typeof vi.fn>;
  countToolExecutions: ReturnType<typeof vi.fn>;
} {
  return {
    countTraces: vi.fn(async () => values.traces ?? 0),
    sumTokens: vi.fn(async () => values.tokens ?? 0),
    countToolExecutions: vi.fn(async () => values.tools ?? 0),
  };
}

describe('sumVisitorsLast7Days', () => {
  it('sums HLEN across 7 day-keyed hashes', async () => {
    const redis = makeRedis();
    const now = new Date('2026-05-22T10:00:00Z');
    // Set HLENs for the last 7 days
    redis._hashes.set('ops:visitors:2026-05-22', 12);
    redis._hashes.set('ops:visitors:2026-05-21', 8);
    redis._hashes.set('ops:visitors:2026-05-20', 11);
    redis._hashes.set('ops:visitors:2026-05-19', 5);
    redis._hashes.set('ops:visitors:2026-05-18', 9);
    redis._hashes.set('ops:visitors:2026-05-17', 4);
    redis._hashes.set('ops:visitors:2026-05-16', 7);
    // Beyond 7 days — shouldn't be counted
    redis._hashes.set('ops:visitors:2026-05-15', 999);

    const total = await sumVisitorsLast7Days(redis, now);
    expect(total).toBe(12 + 8 + 11 + 5 + 9 + 4 + 7);
  });
});

describe('aggregate', () => {
  it('computes tools_per_turn as tools/traces rounded to 1 decimal', async () => {
    const redis = makeRedis();
    redis._hashes.set('ops:visitors:2026-05-22', 10);
    const lf = makeLangfuse({ traces: 100, tokens: 1_234_567, tools: 215 });
    const now = new Date('2026-05-22T14:32:00Z');

    const out = await aggregate(redis, lf, now);
    expect(out.queries).toBe(100);
    expect(out.tokens).toBe(1_234_567);
    expect(out.tools_per_turn).toBe(2.2); // 215/100 = 2.15 → 2.2
    expect(out.visitors).toBe(10);
    expect(out.last_aggregated_at).toBe('2026-05-22T14:32:00.000Z');
    expect(out.is_offline).toBe(false);
  });

  it('returns tools_per_turn = 0 when there are zero traces', async () => {
    const redis = makeRedis();
    const lf = makeLangfuse({ traces: 0, tokens: 0, tools: 0 });
    const out = await aggregate(redis, lf, new Date('2026-05-22T14:32:00Z'));
    expect(out.tools_per_turn).toBe(0);
    expect(out.queries).toBe(0);
  });
});

describe('getOpsSnippet — cache hit', () => {
  it('returns cached blob without invoking Langfuse when fresh', async () => {
    const redis = makeRedis();
    const lf = makeLangfuse({ traces: 999 });
    const now = new Date('2026-05-22T14:32:00Z');
    const cached: OpsSnippet = {
      visitors: 100,
      queries: 50,
      tokens: 1000,
      tools_per_turn: 1.5,
      last_aggregated_at: new Date(now.getTime() - 60_000).toISOString(),
      is_offline: false,
    };
    redis._store.set(SNIPPET_KEY, cached);

    const out = await getOpsSnippet(redis, lf, { now });
    expect(out).toEqual(cached);
    expect(lf.countTraces).not.toHaveBeenCalled();
  });
});

describe('getOpsSnippet — cache miss triggers aggregation', () => {
  it('acquires lock, aggregates, writes cache, releases lock', async () => {
    const redis = makeRedis();
    redis._hashes.set('ops:visitors:2026-05-22', 7);
    const lf = makeLangfuse({ traces: 10, tokens: 500, tools: 23 });
    const now = new Date('2026-05-22T14:32:00Z');

    const out = await getOpsSnippet(redis, lf, { now });
    expect(out.is_offline).toBe(false);
    if (out.is_offline) return;
    expect(out.queries).toBe(10);
    expect(out.tokens).toBe(500);
    expect(out.tools_per_turn).toBe(2.3); // 23/10 = 2.3
    expect(out.visitors).toBe(7);
    // Cache written
    expect(redis._store.get(SNIPPET_KEY)).toEqual(out);
    // Lock released
    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });
});

describe('getOpsSnippet — lock contention', () => {
  it('polls and returns the rebuilder blob once it lands in the cache', async () => {
    const redis = makeRedis({
      set: vi.fn(async (key, _v, opts) => {
        if (key === LOCK_KEY && opts?.nx) return null; // simulate lock held
        return 'OK';
      }),
    });
    const lf = makeLangfuse({ traces: 999 });
    const now = new Date('2026-05-22T14:32:00Z');

    // Rebuilder (elsewhere) writes the blob ~150ms into the poll
    // window. The waiter's first 50ms-interval re-read should pick
    // it up.
    setTimeout(() => {
      const written: OpsSnippet = {
        visitors: 22,
        queries: 7,
        tokens: 314,
        tools_per_turn: 1.1,
        last_aggregated_at: now.toISOString(),
        is_offline: false,
      };
      (redis as ReturnType<typeof makeRedis>)._store.set(SNIPPET_KEY, written);
    }, 150);

    const out = await getOpsSnippet(redis, lf, {
      now,
      lockWaitTotalMs: 2000,
      lockPollIntervalMs: 50,
    });
    expect(out.is_offline).toBe(false);
    if (out.is_offline) return;
    expect(out.queries).toBe(7);
    // Aggregation by THIS caller never ran
    expect(lf.countTraces).not.toHaveBeenCalled();
  });

  it('returns offline when rebuilder never finishes within the wait budget', async () => {
    const redis = makeRedis({
      set: vi.fn(async (key, _v, opts) => {
        if (key === LOCK_KEY && opts?.nx) return null;
        return 'OK';
      }),
    });
    const lf = makeLangfuse();
    const out = await getOpsSnippet(redis, lf, {
      now: new Date('2026-05-22T14:32:00Z'),
      // Effectively zero — fall through to offline immediately, so
      // the test doesn't sit on a wall-clock wait.
      lockWaitTotalMs: 0,
      lockPollIntervalMs: 10,
    });
    expect(out).toEqual(OFFLINE_SNIPPET);
  });
});

describe('getOpsSnippet — error degrades to offline', () => {
  it('Langfuse failure returns offline without throwing', async () => {
    const redis = makeRedis();
    const lf: LangfuseAggregateFns = {
      countTraces: async () => {
        throw new Error('langfuse 500');
      },
      sumTokens: async () => 0,
      countToolExecutions: async () => 0,
    };
    const out = await getOpsSnippet(redis, lf, {
      now: new Date('2026-05-22T14:32:00Z'),
    });
    expect(out).toEqual(OFFLINE_SNIPPET);
    // Lock released even on aggregation failure
    expect((redis as ReturnType<typeof makeRedis>)._store.has(LOCK_KEY)).toBe(
      false,
    );
  });

  it('Redis GET failure falls through and still attempts aggregation', async () => {
    const calls: string[] = [];
    const lf = makeLangfuse({ traces: 5, tokens: 100, tools: 7 });
    const fakeStore = new Map<string, unknown>();
    const redis: SnippetRedis = {
      get: async () => {
        calls.push('get');
        throw new Error('redis 503');
      },
      set: async (key, value) => {
        calls.push(`set:${key}`);
        fakeStore.set(key, value);
        return 'OK';
      },
      del: async (key) => {
        fakeStore.delete(key);
        return 1;
      },
      hlen: async () => 0,
    };

    const out = await getOpsSnippet(redis, lf, {
      now: new Date('2026-05-22T14:32:00Z'),
    });
    expect(out.is_offline).toBe(false);
    if (out.is_offline) return;
    expect(out.queries).toBe(5);
    expect(out.tokens).toBe(100);
    // Aggregation proceeded despite cache-read failure
    expect(lf.countTraces).toHaveBeenCalledOnce();
  });
});
