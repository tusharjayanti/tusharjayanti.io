// Aggregation logic for the M2.8 terminal-page ops snippet.
// Pulls counts from Langfuse + visitor hashes from Redis, mediates
// access with a Redis SETNX lock + 5-min cache so the first-page-load
// hot path stays cheap.
//
// Logic is pure: takes Redis + Langfuse clients as args so tests can
// inject fakes. The edge wrapper at `api/ops-snippet.ts` is the
// thin Vercel handler.

import { visitorHashKey } from './_visitorCounter.js';

export const SNIPPET_KEY = 'ops:snippet:v1';
export const LOCK_KEY = 'ops:snippet:lock';

const FRESH_SECONDS = 5 * 60;
const CACHE_TTL_SECONDS_DEFAULT = 10 * 60;
const LOCK_TTL_SECONDS = 30;
const LOCK_WAIT_MS = 200;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpsSnippetData {
  visitors: number;
  queries: number;
  tokens: number;
  tools_per_turn: number;
  last_aggregated_at: string;
  is_offline: false;
}

export interface OpsSnippetOffline {
  visitors: null;
  queries: null;
  tokens: null;
  tools_per_turn: null;
  last_aggregated_at: null;
  is_offline: true;
}

export type OpsSnippet = OpsSnippetData | OpsSnippetOffline;

export const OFFLINE_SNIPPET: OpsSnippetOffline = {
  visitors: null,
  queries: null,
  tokens: null,
  tools_per_turn: null,
  last_aggregated_at: null,
  is_offline: true,
};

export interface SnippetRedis {
  // Upstash auto-parses JSON when the stored value was JSON. We type
  // get<T>(): Promise<T | null> to match that behavior.
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<'OK' | null>;
  del(key: string): Promise<unknown>;
  hlen(key: string): Promise<number>;
}

export interface LangfuseAggregateFns {
  // Returns the count of root traces (chat-turn) in the window.
  countTraces(fromIso: string, toIso: string): Promise<number>;
  // Sum of input + output tokens across traces in the window.
  sumTokens(fromIso: string, toIso: string): Promise<number>;
  // Count of tool-execution observations in the window.
  countToolExecutions(fromIso: string, toIso: string): Promise<number>;
}

function isFresh(lastAggregatedAt: string, now: Date = new Date()): boolean {
  const ts = Date.parse(lastAggregatedAt);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts < FRESH_SECONDS * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sumVisitorsLast7Days(
  redis: SnippetRedis,
  now: Date = new Date(),
): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    total += await redis.hlen(visitorHashKey(day));
  }
  return total;
}

export async function aggregate(
  redis: SnippetRedis,
  lf: LangfuseAggregateFns,
  now: Date = new Date(),
): Promise<OpsSnippetData> {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();

  const [visitors, queries, tokens, tools] = await Promise.all([
    sumVisitorsLast7Days(redis, now),
    lf.countTraces(fromIso, toIso),
    lf.sumTokens(fromIso, toIso),
    lf.countToolExecutions(fromIso, toIso),
  ]);

  // Avoid divide-by-zero. Round to one decimal so the displayed value
  // matches the spec's 5-line example (`2.1`).
  const tools_per_turn =
    queries > 0 ? Math.round((tools / queries) * 10) / 10 : 0;

  return {
    visitors,
    queries,
    tokens,
    tools_per_turn,
    last_aggregated_at: toIso,
    is_offline: false,
  };
}

export interface GetOpsSnippetOptions {
  cacheTtlSeconds?: number;
  now?: Date;
}

// Top-level read flow. Cache check, lock acquire on miss, fall through
// to offline if everything fails. Wrap individual await sites in
// try/catch so a Redis or Langfuse hiccup degrades to offline rather
// than throwing through the handler.
export async function getOpsSnippet(
  redis: SnippetRedis,
  lf: LangfuseAggregateFns,
  opts: GetOpsSnippetOptions = {},
): Promise<OpsSnippet> {
  const ttl = opts.cacheTtlSeconds ?? CACHE_TTL_SECONDS_DEFAULT;
  const now = opts.now ?? new Date();

  let cached: OpsSnippet | null = null;
  try {
    cached = await redis.get<OpsSnippet>(SNIPPET_KEY);
  } catch (err) {
    console.error('[ops/snippet] cache GET failed:', err);
    cached = null;
  }
  if (
    cached &&
    !cached.is_offline &&
    isFresh(cached.last_aggregated_at, now)
  ) {
    return cached;
  }

  // Cache missing or stale — try to acquire the rebuild lock.
  let gotLock: 'OK' | null = null;
  try {
    gotLock = await redis.set(LOCK_KEY, '1', {
      nx: true,
      ex: LOCK_TTL_SECONDS,
    });
  } catch (err) {
    console.error('[ops/snippet] lock SET failed:', err);
    // Fall through to either stale-cache or offline.
  }

  if (gotLock === 'OK') {
    try {
      const fresh = await aggregate(redis, lf, now);
      try {
        await redis.set(SNIPPET_KEY, fresh, { ex: ttl });
      } catch (err) {
        console.error('[ops/snippet] cache SET failed:', err);
      }
      return fresh;
    } catch (err) {
      console.error('[ops/snippet] aggregation failed:', err);
      // If aggregation throws, return whatever cached we had — even if
      // stale, a known-good blob beats `offline`. If no cache either,
      // return offline.
      if (cached && !cached.is_offline) return cached;
      return OFFLINE_SNIPPET;
    } finally {
      try {
        await redis.del(LOCK_KEY);
      } catch (err) {
        console.error('[ops/snippet] lock DEL failed:', err);
      }
    }
  }

  // Didn't get lock — another invocation is rebuilding. Wait briefly
  // then re-read; if still nothing, return whatever cached we have
  // (even if stale) or offline as the last resort.
  await sleep(LOCK_WAIT_MS);
  try {
    const retry = await redis.get<OpsSnippet>(SNIPPET_KEY);
    if (retry && !retry.is_offline) return retry;
  } catch (err) {
    console.error('[ops/snippet] cache re-GET failed:', err);
  }
  if (cached && !cached.is_offline) return cached;
  return OFFLINE_SNIPPET;
}
