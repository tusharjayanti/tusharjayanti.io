// Aggregation for the /ops Overview tab. Pure functions that turn a
// window's real-human traces + GENERATION observations into the Overview
// data contract, plus a thin Redis cache-aside wrapper.
//
// Split mirrors the ops-snippet module: the math here is pure and
// fixture-tested; the network fetch + Redis client live in the
// api/ops/stats.ts handler and are injected into getOpsStats.

import type { OpsTrace, OpsObservation } from './_opsQuery.js';

export interface ByModelCost {
  sonnet: number;
  haiku: number;
  voyage: number;
  other: number;
}

export interface StepLatency {
  step: string;
  avg_ms: number;
  count: number;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface OpsStatsData {
  window_days: number;
  include_evals: boolean;
  conversations: number;
  cost: {
    total_usd: number;
    per_turn_usd: number;
    by_model: ByModelCost;
  };
  latency: {
    avg_ms: number;
    p50_ms: number;
    by_step: StepLatency[];
  };
  grounded: {
    count: number;
    percent: number; // 0-100, one decimal
  };
  daily: DailyPoint[];
  generated_at: string; // ISO
}

const GROUNDED_TAG = 'grounded';

// Map a Langfuse model id to a cost bucket. Verified model ids in the
// corpus: claude-sonnet-4-6, claude-haiku-4-5(-*), voyage-3.
function modelBucket(model: string): keyof ByModelCost {
  if (model.startsWith('claude-sonnet')) return 'sonnet';
  if (model.startsWith('claude-haiku')) return 'haiku';
  if (model.startsWith('voyage')) return 'voyage';
  return 'other';
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx];
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

// Build the full day series for the window, oldest→newest, zero-filled.
function dailySeries(
  traces: OpsTrace[],
  now: Date,
  windowDays: number,
): DailyPoint[] {
  const counts = new Map<string, number>();
  for (const t of traces) {
    const d = utcDay(t.timestamp);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const series: DailyPoint[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return series;
}

export interface AggregateOptions {
  windowDays: number;
  includeEvals: boolean;
  now: Date;
}

// Aggregate ALREADY-SCOPED real-human traces + the window's observations
// into the Overview contract. `traces` must be the realUser-filtered set;
// `observations` is the raw GENERATION list (binned here against the kept
// trace ids, so eval/defense observations are dropped with their traces).
export function aggregateStats(
  traces: OpsTrace[],
  observations: OpsObservation[],
  opts: AggregateOptions,
): OpsStatsData {
  const conversations = traces.length;
  const keptIds = new Set(traces.map((t) => t.id));

  // Cost: total from trace rollups; by-model from observations under kept traces.
  const total_usd = traces.reduce((a, t) => a + t.totalCost, 0);
  const by_model: ByModelCost = { sonnet: 0, haiku: 0, voyage: 0, other: 0 };
  const stepAgg = new Map<string, { total: number; count: number }>();
  for (const o of observations) {
    if (!keptIds.has(o.traceId)) continue;
    by_model[modelBucket(o.model)] += o.calculatedTotalCost;
    if (o.name) {
      const s = stepAgg.get(o.name) ?? { total: 0, count: 0 };
      s.total += o.latency;
      s.count += 1;
      stepAgg.set(o.name, s);
    }
  }

  // Latency: trace-level avg + p50 (seconds → ms).
  const latenciesMs = traces.map((t) => t.latency * 1000);
  const avg_ms =
    latenciesMs.length === 0
      ? 0
      : latenciesMs.reduce((a, x) => a + x, 0) / latenciesMs.length;
  const p50_ms = percentile(
    [...latenciesMs].sort((a, b) => a - b),
    50,
  );

  const by_step: StepLatency[] = [...stepAgg.entries()]
    .map(([step, s]) => ({
      step,
      avg_ms: round((s.total / s.count) * 1000, 0),
      count: s.count,
    }))
    .sort((a, b) => b.count - a.count);

  const groundedCount = traces.filter((t) =>
    t.tags.includes(GROUNDED_TAG),
  ).length;

  return {
    window_days: opts.windowDays,
    include_evals: opts.includeEvals,
    conversations,
    cost: {
      total_usd: round(total_usd, 6),
      per_turn_usd:
        conversations === 0 ? 0 : round(total_usd / conversations, 6),
      by_model: {
        sonnet: round(by_model.sonnet, 6),
        haiku: round(by_model.haiku, 6),
        voyage: round(by_model.voyage, 6),
        other: round(by_model.other, 6),
      },
    },
    latency: {
      avg_ms: round(avg_ms, 0),
      p50_ms: round(p50_ms, 0),
      by_step,
    },
    grounded: {
      count: groundedCount,
      percent:
        conversations === 0
          ? 0
          : round((groundedCount / conversations) * 100, 1),
    },
    daily: dailySeries(traces, opts.now, opts.windowDays),
    generated_at: opts.now.toISOString(),
  };
}

// ---- cache-aside ----

export interface OpsStatsRedis {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
}

export interface GetOpsStatsResult {
  data: OpsStatsData;
  cached: boolean;
  stale: boolean;
}

// Stale-while-revalidate cache-aside. The stored value is wrapped in an
// envelope { v, t } (t = epoch ms written) and persisted with a HARD TTL
// (soft x HARD_TTL_MULTIPLIER). On read:
//   - fresh (age <= soft TTL)         -> return it, no refresh.
//   - soft-expired but still present  -> return STALE instantly + refresh in
//                                        the background (via scheduleRefresh,
//                                        i.e. @vercel/functions waitUntil).
//   - absent / hard-expired / legacy  -> compute synchronously.
// So only a genuine first-ever or long-inactive request pays the cold sweep;
// everything else feels warm. The caller's `ttlSeconds` is the SOFT TTL.
const HARD_TTL_MULTIPLIER = 4;

interface CacheEnvelope<T> {
  v: T;
  t: number;
}

function isEnvelope<T>(value: unknown): value is CacheEnvelope<T> {
  return (
    !!value &&
    typeof value === 'object' &&
    'v' in value &&
    't' in value &&
    typeof (value as { t: unknown }).t === 'number'
  );
}

async function computeAndStore<T extends object>(
  redis: OpsStatsRedis,
  cacheKey: string,
  hardTtlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const data = await compute();
  try {
    await redis.set(
      cacheKey,
      { v: data, t: Date.now() } satisfies CacheEnvelope<T>,
      { ex: hardTtlSeconds },
    );
  } catch (err) {
    console.error('[ops] cache SET failed:', cacheKey, err);
  }
  return data;
}

export interface CacheAsideOptions {
  // Injectable clock for deterministic tests.
  now?: number;
  // Background-refresh scheduler. Handlers pass @vercel/functions waitUntil;
  // tests pass a spy. When absent, the refresh still runs fire-and-forget.
  scheduleRefresh?: (p: Promise<unknown>) => void;
}

export async function cacheAside<T extends object>(
  redis: OpsStatsRedis,
  cacheKey: string,
  softTtlSeconds: number,
  compute: () => Promise<T>,
  opts: CacheAsideOptions = {},
): Promise<{ data: T; cached: boolean; stale: boolean }> {
  const now = opts.now ?? Date.now();
  const hardTtlSeconds = softTtlSeconds * HARD_TTL_MULTIPLIER;

  let envelope: CacheEnvelope<T> | null = null;
  try {
    envelope = await redis.get<CacheEnvelope<T>>(cacheKey);
  } catch (err) {
    console.error('[ops] cache GET failed:', cacheKey, err);
    envelope = null;
  }

  if (isEnvelope<T>(envelope)) {
    if (now - envelope.t <= softTtlSeconds * 1000) {
      return { data: envelope.v, cached: true, stale: false };
    }
    // Soft-expired but Redis still held it (within hard TTL): serve stale,
    // refresh in the background so the NEXT reader gets fresh data.
    const refresh = computeAndStore(
      redis,
      cacheKey,
      hardTtlSeconds,
      compute,
    ).catch((err) => {
      console.error('[ops] background refresh failed:', cacheKey, err);
    });
    if (opts.scheduleRefresh) {
      try {
        opts.scheduleRefresh(refresh);
      } catch (err) {
        console.error('[ops] scheduleRefresh failed:', cacheKey, err);
      }
    }
    return { data: envelope.v, cached: true, stale: true };
  }

  // Absent, hard-expired, or a legacy bare (pre-SWR) value: compute now.
  const data = await computeAndStore(redis, cacheKey, hardTtlSeconds, compute);
  return { data, cached: false, stale: false };
}

// Stats-typed wrapper kept for the handler + its existing tests.
export async function getOpsStats(
  redis: OpsStatsRedis,
  cacheKey: string,
  softTtlSeconds: number,
  compute: () => Promise<OpsStatsData>,
  opts?: CacheAsideOptions,
): Promise<GetOpsStatsResult> {
  return cacheAside<OpsStatsData>(
    redis,
    cacheKey,
    softTtlSeconds,
    compute,
    opts,
  );
}
