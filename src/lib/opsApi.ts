// Generic fetch hook for the /ops dashboard: keyed in-memory cache (instant
// tab switches), AbortController (cancels stale requests on param change),
// and automatic 401 → re-gate. The session cookie is httpOnly, so requests
// just rely on same-origin credentials — no Authorization header to manage.
//
// Mirrors the server contract in api/_opsStats.ts. Client-side types are
// duplicated here (same convention as src/lib/opsSnippet.ts) rather than
// imported across the api/ ↔ src/ project boundary.

import { useEffect, useRef, useState } from 'react';

// ---- contract types (mirror api/_opsStats.ts) ----

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
  date: string;
  count: number;
}

export interface StatsData {
  window_days: number;
  include_evals: boolean;
  conversations: number;
  cost: { total_usd: number; per_turn_usd: number; by_model: ByModelCost };
  latency: { avg_ms: number; p50_ms: number; by_step: StepLatency[] };
  grounded: { count: number; percent: number };
  daily: DailyPoint[];
  generated_at: string;
}

// ---- keyed cache ----

type CacheEntry = { ts: number; data: unknown };
const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 30_000;

function cacheKey(
  url: string,
  params: Record<string, string | number | boolean>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${url}?${sorted}`;
}

export function clearOpsCache(): void {
  cache.clear();
}

export interface UseOpsApiOptions {
  url: string;
  params?: Record<string, string | number | boolean>;
  ttlMs?: number;
  // Called when a request returns 401 so the shell can drop back to the gate.
  onUnauthorized?: () => void;
}

export interface UseOpsApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useOpsApi<T>(opts: UseOpsApiOptions): UseOpsApiResult<T> {
  const { url, params = {}, ttlMs = DEFAULT_TTL_MS, onUnauthorized } = opts;
  const key = cacheKey(url, params);

  const [data, setData] = useState<T | null>(() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.ts < ttlMs ? (hit.data as T) : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Keep the unauthorized callback fresh without retriggering the effect.
  const onUnauthRef = useRef(onUnauthorized);
  onUnauthRef.current = onUnauthorized;

  useEffect(() => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) {
      setData(hit.data as T);
      setError(null);
      return;
    }

    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch(
      `${url}?${new URLSearchParams(
        Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      ).toString()}`,
      { signal: ac.signal, credentials: 'same-origin' },
    )
      .then(async (res) => {
        if (res.status === 401) {
          onUnauthRef.current?.();
          throw new Error('unauthorized');
        }
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const json = (await res.json()) as T;
        cache.set(key, { ts: Date.now(), data: json });
        setData(json);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'request failed');
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
    // params is captured via `key`; nonce forces a manual refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ttlMs, nonce]);

  return { data, loading, error, refetch: () => setNonce((n) => n + 1) };
}
