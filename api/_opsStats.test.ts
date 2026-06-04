import { describe, it, expect, vi } from 'vitest';

import {
  aggregateStats,
  cacheAside,
  getOpsStats,
  type OpsStatsData,
  type OpsStatsRedis,
} from './_opsStats.js';
import type { OpsTrace, OpsObservation } from './_opsQuery.js';

function trace(
  id: string,
  timestamp: string,
  tags: string[],
  totalCost: number,
  latency: number,
): OpsTrace {
  return { id, name: 'chat-turn', timestamp, tags, totalCost, latency };
}

function obs(
  traceId: string,
  name: string,
  model: string,
  calculatedTotalCost: number,
  latency: number,
): OpsObservation {
  return {
    id: `${traceId}-${name}`,
    traceId,
    name,
    model,
    calculatedTotalCost,
    latency,
    startTime: '2026-05-22T00:00:00Z',
  };
}

describe('aggregateStats', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const traces: OpsTrace[] = [
    trace('t1', '2026-05-22T08:00:00Z', ['grounded'], 0.02, 2.0),
    trace('t2', '2026-05-21T08:00:00Z', [], 0.01, 1.0),
    trace(
      't3',
      '2026-05-22T09:00:00Z',
      ['grounded', 'model-refused'],
      0.03,
      3.0,
    ),
  ];
  const observations: OpsObservation[] = [
    obs('t1', 'anthropic_first_call', 'claude-sonnet-4-6', 0.015, 1.8),
    obs('t1', 'rerank', 'claude-haiku-4-5', 0.001, 0.2),
    obs('t2', 'anthropic_first_call', 'claude-sonnet-4-6', 0.01, 1.0),
    obs('t3', 'embedding', 'voyage-3', 0, 0.05),
    // observation under a trace NOT in the kept set — must be ignored.
    obs('eval-x', 'anthropic_first_call', 'claude-sonnet-4-6', 999, 9),
  ];
  const stats = aggregateStats(traces, observations, {
    windowDays: 7,
    includeEvals: false,
    now,
  });

  it('counts conversations and total/per-turn cost', () => {
    expect(stats.conversations).toBe(3);
    expect(stats.cost.total_usd).toBeCloseTo(0.06, 6);
    expect(stats.cost.per_turn_usd).toBeCloseTo(0.02, 6);
  });

  it('buckets cost by model and ignores observations off the kept set', () => {
    expect(stats.cost.by_model.sonnet).toBeCloseTo(0.025, 6);
    expect(stats.cost.by_model.haiku).toBeCloseTo(0.001, 6);
    expect(stats.cost.by_model.voyage).toBe(0);
    expect(stats.cost.by_model.other).toBe(0); // the 999 eval obs excluded
  });

  it('computes trace-level latency avg + p50 in ms', () => {
    expect(stats.latency.avg_ms).toBe(2000); // (2+1+3)/3 s
    expect(stats.latency.p50_ms).toBe(2000);
  });

  it('aggregates latency by step, most-frequent first', () => {
    const first = stats.latency.by_step[0];
    expect(first.step).toBe('anthropic_first_call');
    expect(first.count).toBe(2);
    expect(first.avg_ms).toBe(1400); // (1.8 + 1.0)/2 s
    const steps = Object.fromEntries(
      stats.latency.by_step.map((s) => [s.step, s.avg_ms]),
    );
    expect(steps.rerank).toBe(200);
    expect(steps.embedding).toBe(50);
  });

  it('computes grounded count + percent', () => {
    expect(stats.grounded.count).toBe(2);
    expect(stats.grounded.percent).toBe(66.7);
  });

  it('builds a zero-filled daily series for the window', () => {
    expect(stats.daily).toHaveLength(7);
    expect(stats.daily[0].date).toBe('2026-05-16'); // oldest
    expect(stats.daily[6].date).toBe('2026-05-22'); // newest = now
    const byDate = Object.fromEntries(
      stats.daily.map((d) => [d.date, d.count]),
    );
    expect(byDate['2026-05-22']).toBe(2); // t1 + t3
    expect(byDate['2026-05-21']).toBe(1); // t2
    expect(byDate['2026-05-20']).toBe(0);
  });

  it('passes through window metadata + generated_at', () => {
    expect(stats.window_days).toBe(7);
    expect(stats.include_evals).toBe(false);
    expect(stats.generated_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('handles an empty window without dividing by zero', () => {
    const empty = aggregateStats([], [], {
      windowDays: 1,
      includeEvals: false,
      now,
    });
    expect(empty.conversations).toBe(0);
    expect(empty.cost.per_turn_usd).toBe(0);
    expect(empty.grounded.percent).toBe(0);
    expect(empty.latency.p50_ms).toBe(0);
    expect(empty.daily).toHaveLength(1);
  });
});

describe('cacheAside (stale-while-revalidate)', () => {
  const sample: OpsStatsData = {
    window_days: 7,
    include_evals: false,
    conversations: 1,
    cost: {
      total_usd: 0.01,
      per_turn_usd: 0.01,
      by_model: { sonnet: 0.01, haiku: 0, voyage: 0, other: 0 },
    },
    latency: { avg_ms: 1000, p50_ms: 1000, by_step: [] },
    grounded: { count: 0, percent: 0 },
    daily: [],
    generated_at: '2026-05-22T12:00:00.000Z',
  };
  const sample2: OpsStatsData = { ...sample, conversations: 99 };

  const SOFT = 300;
  const HARD = SOFT * 4; // matches HARD_TTL_MULTIPLIER
  const NOW = 1_700_000_000_000;
  const envelope = (v: OpsStatsData, t: number) => ({ v, t });

  // Mocks held as explicit refs; the redis object is cast to the interface
  // (a vi.fn can't structurally satisfy the generic get<T>).
  function fakeRedis(getImpl: () => Promise<unknown>) {
    const get = vi.fn(getImpl);
    const set = vi.fn(async () => 'OK');
    return { redis: { get, set } as unknown as OpsStatsRedis, get, set };
  }

  it('hard-cold miss computes synchronously and stores an enveloped value', async () => {
    const { redis, set } = fakeRedis(async () => null);
    const compute = vi.fn(async () => sample);
    const { data, cached, stale } = await cacheAside(
      redis,
      'ops:rollup:7:false',
      SOFT,
      compute,
      { now: NOW },
    );
    expect({ cached, stale }).toEqual({ cached: false, stale: false });
    expect(data).toEqual(sample);
    expect(compute).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      'ops:rollup:7:false',
      { v: sample, t: expect.any(Number) },
      { ex: HARD },
    );
  });

  it('a legacy bare (pre-SWR) value is treated as cold and recomputed', async () => {
    const { redis, set } = fakeRedis(async () => sample); // no { v, t } envelope
    const compute = vi.fn(async () => sample2);
    const { data, cached } = await cacheAside(redis, 'k', SOFT, compute, {
      now: NOW,
    });
    expect(cached).toBe(false);
    expect(data).toEqual(sample2);
    expect(compute).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
  });

  it('fresh envelope returns without computing or refreshing', async () => {
    const { redis, set } = fakeRedis(async () => envelope(sample, NOW - 1000));
    const compute = vi.fn(async () => sample);
    const scheduleRefresh = vi.fn();
    const { data, cached, stale } = await cacheAside(
      redis,
      'k',
      SOFT,
      compute,
      {
        now: NOW,
        scheduleRefresh,
      },
    );
    expect({ cached, stale }).toEqual({ cached: true, stale: false });
    expect(data).toEqual(sample);
    expect(compute).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });

  it('soft-expired returns stale instantly and schedules a refresh that rewrites the key', async () => {
    // Stored (SOFT+1)s ago: past the soft TTL, still within the hard TTL.
    const { redis, set } = fakeRedis(async () =>
      envelope(sample, NOW - (SOFT + 1) * 1000),
    );
    const compute = vi.fn(async () => sample2); // refresh yields NEW data
    let scheduled: Promise<unknown> | null = null;
    const scheduleRefresh = vi.fn((p: Promise<unknown>) => {
      scheduled = p;
    });

    const { data, cached, stale } = await cacheAside(
      redis,
      'k',
      SOFT,
      compute,
      {
        now: NOW,
        scheduleRefresh,
      },
    );

    // Served the STALE value immediately.
    expect({ cached, stale }).toEqual({ cached: true, stale: true });
    expect(data).toEqual(sample);
    expect(scheduleRefresh).toHaveBeenCalledOnce();

    // The scheduled refresh recomputes and rewrites the key with fresh data.
    expect(scheduled).not.toBeNull();
    await scheduled;
    expect(compute).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      'k',
      { v: sample2, t: expect.any(Number) },
      { ex: HARD },
    );
  });

  it('falls back to compute when the cache GET throws', async () => {
    const { redis } = fakeRedis(async () => {
      throw new Error('redis down');
    });
    const compute = vi.fn(async () => sample);
    const { cached } = await cacheAside(redis, 'k', SOFT, compute, {
      now: NOW,
    });
    expect(cached).toBe(false);
    expect(compute).toHaveBeenCalledOnce();
  });

  it('getOpsStats delegates to cacheAside (stale-aware result)', async () => {
    const { redis } = fakeRedis(async () => envelope(sample, NOW - 1000));
    const compute = vi.fn(async () => sample);
    const res = await getOpsStats(redis, 'k', SOFT, compute, { now: NOW });
    expect(res).toEqual({ data: sample, cached: true, stale: false });
  });
});
