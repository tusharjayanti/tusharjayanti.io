// Langfuse REST client for the ops snippet aggregation.
// The langfuse SDK is built for ingestion (trace/observation writes);
// for read queries we hit the public REST API directly. Basic-auth
// with the existing LANGFUSE_PUBLIC_KEY / SECRET_KEY pair.
//
// Used only by api/_opsSnippet.ts. Errors propagate to the caller
// which is responsible for falling through to the offline state.

import type { LangfuseAggregateFns } from './_opsSnippet.js';

const TRACE_NAME = 'chat-turn';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // safety — 50 × 100 = 5000 items in 7d window

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
  // pricing). Missing/null is treated as 0 by sumGenerationCostWindow.
  calculatedTotalCost?: number | null;
}

interface ListResponse<T> {
  data: T[];
  meta?: { totalItems?: number; totalPages?: number };
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return 'Basic ' + btoa(`${publicKey}:${secretKey}`);
}

async function langfuseGet<T>(
  baseUrl: string,
  path: string,
  publicKey: string,
  secretKey: string,
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(publicKey, secretKey),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`langfuse ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

// Paginates through /api/public/traces filtered by name + timestamp.
// Trace-root usage fields are always null in Langfuse — token totals
// live on individual observations and are pulled separately by
// sumGenerationTokensWindow.
async function countTracesWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      name: TRACE_NAME,
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

// Sum token totals across GENERATION-type observations in the window.
// This is where Langfuse actually records usage — the chat-turn trace
// roots leave usage null and only the per-Anthropic-call generation
// observations carry the numbers. We don't filter by trace name
// (there's no observations-side filter for that), so the sum
// includes any other GENERATION observation in the window. For the
// HUD's "tokens last 7d" purpose, that's the right semantic — total
// tokens spent.
async function sumGenerationTokensWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  let total = 0;
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
      const tokens = obs.totalTokens ?? obs.usage?.total ?? 0;
      total += tokens ?? 0;
    }
    if (items.length < PAGE_LIMIT) break;
  }
  return total;
}

// Sum Langfuse-computed USD cost across GENERATION observations in the
// window. Same pagination + unfiltered-by-name semantics as
// sumGenerationTokensWindow (the total is all inference spend in the
// window). Missing/null cost counts as 0 — e.g. Voyage embeddings,
// which Langfuse doesn't price, so the cost metric is Sonnet + Haiku
// spend in practice.
async function sumGenerationCostWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  let total = 0;
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
      total += obs.calculatedTotalCost ?? 0;
    }
    if (items.length < PAGE_LIMIT) break;
  }
  return total;
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

  // Each metric is cached separately because they come from different
  // endpoints (traces / traces?tags / observations[GENERATION]). The
  // aggregator calls them in parallel inside one snippet rebuild — each
  // cache is at most fetched once per process tick.
  let tracesPromise: Promise<number> | null = null;
  let tokensPromise: Promise<number> | null = null;
  let groundedPromise: Promise<number> | null = null;
  let costPromise: Promise<number> | null = null;

  return {
    async countTraces(fromIso, toIso) {
      if (tracesPromise === null) {
        tracesPromise = countTracesWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
        );
      }
      return tracesPromise;
    },
    async sumTokens(fromIso, toIso) {
      if (tokensPromise === null) {
        tokensPromise = sumGenerationTokensWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
        );
      }
      return tokensPromise;
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
      if (costPromise === null) {
        costPromise = sumGenerationCostWindow(
          baseUrl,
          publicKey,
          secretKey,
          fromIso,
          toIso,
        );
      }
      return costPromise;
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
