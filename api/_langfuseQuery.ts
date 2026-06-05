// Langfuse REST client for the ops snippet aggregation.
// The langfuse SDK is built for ingestion (trace/observation writes);
// for read queries we hit the public REST API directly. Basic-auth
// with the existing LANGFUSE_PUBLIC_KEY / SECRET_KEY pair.
//
// Used only by api/_opsSnippet.ts. Errors propagate to the caller
// which is responsible for falling through to the offline state.

import type { LangfuseAggregateFns } from './_opsSnippet.js';
import { opsQuery, realUser } from './_opsQuery.js';

const TRACE_NAME = 'chat-turn';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // safety — 50 × 100 = 5000 items in 7d window

// Transient statuses worth retrying. 429 is the one we actually hit: the
// snippet aggregation fires several paginations in parallel and bursts
// past Langfuse Cloud's rate limit on deep pages, sinking the whole
// aggregate to `offline`. 5xx covered for resilience. Backoff schedule
// mirrors api/_opsQuery.ts so both Langfuse read paths behave the same;
// its length also bounds the retry count.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [2000, 5000, 15000];
const JITTER_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  return BACKOFF_MS[attempt] + Math.floor(Math.random() * JITTER_MS);
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into a ms delay,
// or null when absent/unparseable so the caller falls back to the
// exponential schedule. Past dates clamp to 0.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

interface TraceListItem {
  id: string;
}

interface GenerationListItem {
  id: string;
  // Verified against Langfuse Cloud (Tokyo) 2026-05-22 — observation
  // objects expose both `totalTokens` (flat) and `usage.total`
  // (nested). Trace roots have these as null; observations carry the
  // real numbers. Tolerate either shape across Langfuse versions.
  totalTokens?: number | null;
  usage?: { total?: number | null } | null;
  // Langfuse-computed USD cost for the observation (model + token
  // priced). The REST shape leaves `totalCost` null; `calculatedTotalCost`
  // is the populated field. Verified 2026-05-25: non-zero for Anthropic
  // generations, 0 for Voyage embeddings (Langfuse carries no voyage-3
  // pricing). Missing/null is treated as 0 by sumGenerationUsageWindow.
  calculatedTotalCost?: number | null;
}

interface ListResponse<T> {
  data: T[];
  meta?: { totalItems?: number; totalPages?: number };
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return 'Basic ' + btoa(`${publicKey}:${secretKey}`);
}

// GET with retry/backoff on transient failures. 429 (and 5xx) retry on
// the BACKOFF_MS schedule, honoring a Retry-After header when present; any
// other non-2xx, or exhausting the schedule, throws. Without this, one
// rate-limited deep page rejects the parallel aggregate and the whole
// snippet falls to `offline`.
async function langfuseGet<T>(
  baseUrl: string,
  path: string,
  publicKey: string,
  secretKey: string,
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(publicKey, secretKey),
        Accept: 'application/json',
      },
    });
    if (res.ok) return (await res.json()) as T;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === BACKOFF_MS.length) {
      throw new Error(`langfuse ${path} returned ${res.status}`);
    }
    const wait = parseRetryAfter(res.headers.get('retry-after'));
    await sleep(wait ?? jitteredBackoff(attempt));
  }
  // Unreachable: the final attempt either returns or throws above.
  throw new Error(`langfuse ${path} exhausted retries`);
}

// Real-human conversation count for the window. Repointed to the
// canonical ops read layer (M4 A3). Previously this counted EVERY
// chat-turn trace in the window — eval-source + defense/error traffic
// included — so the HUD's headline swung with eval batches (~95 in a
// quiet window vs ~542 mid-batch). Now opsQuery drops eval-source and
// realUser drops injection-detected / rate-limited / streamed-error,
// leaving only real human turns. windowDays is derived from the ISO
// range the aggregate passes so this stays window-agnostic; `now` is
// pinned to toIso so opsQuery reproduces the exact same window.
async function countTracesWindow(
  fromIso: string,
  toIso: string,
): Promise<number> {
  const windowDays =
    (Date.parse(toIso) - Date.parse(fromIso)) / (24 * 60 * 60 * 1000);
  const { traces } = await opsQuery({
    windowDays,
    includeEvals: false,
    now: new Date(toIso),
  });
  return realUser(traces).length;
}

// Same as countTracesWindow but filtered to traces carrying `tag`.
// Langfuse's /api/public/traces supports a server-side `tags` query
// param — verified 2026-05-25 that it filters server-side (an unknown
// tag returns 0, a known tag returns its subset) rather than being
// ignored. Used for the HUD's queries_grounded % via the `grounded` tag.
async function countTracesWithTagWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
  tag: string,
): Promise<number> {
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      name: TRACE_NAME,
      tags: tag,
      fromTimestamp: fromIso,
      toTimestamp: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    const res = await langfuseGet<ListResponse<TraceListItem>>(
      baseUrl,
      `/api/public/traces?${qs.toString()}`,
      publicKey,
      secretKey,
    );
    const items = res.data ?? [];
    count += items.length;
    if (items.length < PAGE_LIMIT) break;
  }
  return count;
}

interface GenerationUsage {
  tokens: number;
  cost: number;
}

// Single paginated pass over GENERATION-type observations in the window,
// summing BOTH token usage and Langfuse-computed USD cost. Tokens and cost
// previously drove two byte-identical paginations over this same endpoint;
// collapsing them halves the request burst (and the latency) that was
// tipping the parallel snippet aggregation past Langfuse's rate limit.
//
// Usage lives on the per-Anthropic-call generation observations — chat-turn
// trace roots leave it null. We don't filter by trace name (there's no
// observations-side filter for that), so the sums are total spend in the
// window, which is the right semantic for the HUD's "last 7d" figures.
// Missing/null fields count as 0 — e.g. Voyage embeddings, which Langfuse
// doesn't price, so cost is Sonnet + Haiku spend in practice.
async function sumGenerationUsageWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<GenerationUsage> {
  let tokens = 0;
  let cost = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      type: 'GENERATION',
      fromStartTime: fromIso,
      toStartTime: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    const res = await langfuseGet<ListResponse<GenerationListItem>>(
      baseUrl,
      `/api/public/observations?${qs.toString()}`,
      publicKey,
      secretKey,
    );
    const items = res.data ?? [];
    for (const obs of items) {
      tokens += obs.totalTokens ?? obs.usage?.total ?? 0;
      cost += obs.calculatedTotalCost ?? 0;
    }
    if (items.length < PAGE_LIMIT) break;
  }
  return { tokens, cost };
}

// Returns null if Langfuse env vars are missing. The ops handler
// treats that as "Langfuse-side aggregation is disabled" and ships
// queries=0 / tokens=0 / grounded=0 / cost=0 alongside the real
// visitor count rather than failing the whole snippet. Real production
// always has these set.
export function makeLangfuseAggregate(): LangfuseAggregateFns | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) return null;

  // Each metric is memoized because the aggregator calls them in parallel
  // inside one snippet rebuild — each underlying fetch fires at most once
  // per process tick. tokens + cost share ONE observation pagination
  // (usagePromise): they read the same GENERATION endpoint, so one pass
  // feeds both and the snippet issues half the observation requests.
  let tracesPromise: Promise<number> | null = null;
  let usagePromise: Promise<GenerationUsage> | null = null;
  let groundedPromise: Promise<number> | null = null;

  return {
    async countTraces(fromIso, toIso) {
      if (tracesPromise === null) {
        tracesPromise = countTracesWindow(fromIso, toIso);
      }
      return tracesPromise;
    },
    async sumTokens(fromIso, toIso) {
      if (usagePromise === null) {
        usagePromise = sumGenerationUsageWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
        );
      }
      return (await usagePromise).tokens;
    },
    async countGroundedTraces(fromIso, toIso, tag) {
      if (groundedPromise === null) {
        groundedPromise = countTracesWithTagWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
          tag,
        );
      }
      return groundedPromise;
    },
    async sumCost(fromIso, toIso) {
      if (usagePromise === null) {
        usagePromise = sumGenerationUsageWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
        );
      }
      return (await usagePromise).cost;
    },
  };
}

// Fallback aggregate when Langfuse env vars are missing. Returns
// zeros so the snippet still renders with the live visitor count.
export const ZERO_LANGFUSE_AGGREGATE: LangfuseAggregateFns = {
  countTraces: async () => 0,
  sumTokens: async () => 0,
  countGroundedTraces: async () => 0,
  sumCost: async () => 0,
};
