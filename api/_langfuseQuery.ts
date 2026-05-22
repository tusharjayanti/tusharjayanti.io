// Langfuse REST client for the M2.8 ops snippet aggregation.
// The langfuse SDK is built for ingestion (trace/observation writes);
// for read queries we hit the public REST API directly. Basic-auth
// with the existing LANGFUSE_PUBLIC_KEY / SECRET_KEY pair.
//
// Used only by api/_opsSnippet.ts. Errors propagate to the caller
// which is responsible for falling through to the offline state.

import type { LangfuseAggregateFns } from './_opsSnippet.js';

const TRACE_NAME = 'chat-turn';
const TOOL_OBSERVATION_NAME = 'tool-execution';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // safety — 50 × 100 = 5000 items in 7d window

interface TraceListItem {
  id: string;
  totalTokens?: number | null;
  usage?: { total?: number | null } | null;
}

interface ObservationListItem {
  id: string;
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

// Paginates through /api/public/traces filtered by name + timestamp,
// accumulating count and totalTokens. The traces endpoint's `usage`
// field shape has changed across langfuse versions; we tolerate
// either `totalTokens` (older) or `usage.total` (newer).
async function listTracesWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<{ count: number; totalTokens: number }> {
  let count = 0;
  let totalTokens = 0;
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
    for (const t of items) {
      count += 1;
      const tokens =
        t.totalTokens ?? t.usage?.total ?? 0;
      totalTokens += tokens ?? 0;
    }
    if (items.length < PAGE_LIMIT) break;
  }
  return { count, totalTokens };
}

async function countObservationsWindow(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  let count = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      type: 'SPAN',
      name: TOOL_OBSERVATION_NAME,
      fromStartTime: fromIso,
      toStartTime: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    const res = await langfuseGet<ListResponse<ObservationListItem>>(
      baseUrl,
      `/api/public/observations?${qs.toString()}`,
      publicKey,
      secretKey,
    );
    const items = res.data ?? [];
    count += items.length;
    if (items.length < PAGE_LIMIT) break;
  }
  return count;
}

// Returns null if Langfuse env vars are missing. The ops handler
// treats that as "Langfuse-side aggregation is disabled" and ships
// queries=0 / tokens=0 / tools=0 alongside the real visitor count
// rather than failing the whole snippet. Real production always has
// these set.
export function makeLangfuseAggregate(): LangfuseAggregateFns | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) return null;

  // Cache trace list across the 3 functions so we only paginate once
  // per snippet rebuild. countTraces and sumTokens both come from the
  // same /traces response.
  let cached: Promise<{ count: number; totalTokens: number }> | null = null;
  const traces = (fromIso: string, toIso: string) => {
    if (cached === null) {
      cached = listTracesWindow(baseUrl, publicKey, secretKey, fromIso, toIso);
    }
    return cached;
  };

  return {
    async countTraces(fromIso, toIso) {
      const t = await traces(fromIso, toIso);
      return t.count;
    },
    async sumTokens(fromIso, toIso) {
      const t = await traces(fromIso, toIso);
      return t.totalTokens;
    },
    async countToolExecutions(fromIso, toIso) {
      return countObservationsWindow(
        baseUrl,
        publicKey,
        secretKey,
        fromIso,
        toIso,
      );
    },
  };
}

// Fallback aggregate when Langfuse env vars are missing. Returns
// zeros so the snippet still renders with the live visitor count.
export const ZERO_LANGFUSE_AGGREGATE: LangfuseAggregateFns = {
  countTraces: async () => 0,
  sumTokens: async () => 0,
  countToolExecutions: async () => 0,
};
