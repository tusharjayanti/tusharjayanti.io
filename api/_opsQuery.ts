// Canonical Langfuse trace-fetch for the ops read path.
//
// ONE code path shared by both the /ops dashboard read (api/ — Node
// serverless) and the cost script (scripts/cost/measure.ts — Node tsx).
// Before this module the two diverged: the HUD aggregate
// (api/_langfuseQuery.ts) counted *every* chat-turn trace with no tag
// exclusion, while the cost script paginated fully AND excluded
// eval-source + error-tag traffic (logic inlined in measure.ts). That
// divergence is exactly what produced the 95-vs-458 trace-count delta.
//
// opsQuery centralizes:
//   - full pagination (loop until exhausted, hard cap)
//   - eval-source exclusion (default on; the same `eval-source` tag
//     producers attach in api/chat.ts when X-Eval-Bypass validates)
//   - 429 backoff (Langfuse Hobby tier rate-limits aggressively)
//
// opsObservations is the matching GENERATION-observation fetch used for
// by-model cost + latency-by-step breakdowns; it shares the same
// paginator + backoff.
//
// realUser() is the second scope axis: it drops defense/error-tagged
// traces. Real-human count = realUser(opsQuery({includeEvals:false}).traces).

const TRACE_NAME = 'chat-turn';
const PAGE_LIMIT = 100;
// Hard cap: 20 pages × 100 = 2000 items. Well above the real 7-day
// volume (hundreds incl. an eval batch); a runaway-loop backstop, not
// a working ceiling. The paginator THROWS if it hits the cap rather
// than silently truncating — a truncated count is the failure mode
// we're trying to eliminate, so it must be loud.
const MAX_PAGES = 20;

// The literal tag producers attach to trusted eval-runner traffic
// (api/chat.ts: `tags.push('eval-source')` once X-Eval-Bypass matches).
// NOTE the tag is `eval-source`, NOT a `source:`-prefixed tag — a query
// that excludes on a `source:` prefix excludes nothing.
const EVAL_SOURCE_TAG = 'eval-source';

// Defense/error tags. A trace carrying any of these is NOT a real human
// conversation — it short-circuited (rate-limited / injection-detected)
// or broke mid-stream (streamed-error) before being a normal turn. This
// is the SAME set the cost script excludes inline (measure.ts EXCLUDE_TAGS);
// realUser() is the single shared definition so both read identically.
// This axis is SEPARATE from eval-source, which opsQuery owns.
const DEFENSE_TAGS = new Set([
  'injection-detected',
  'rate-limited',
  'streamed-error',
]);

const DEFAULT_BASE_URL = 'https://jp.cloud.langfuse.com';

// Exponential backoff for Langfuse Hobby-tier 429s. Ported from
// scripts/cost/measure.ts (2s, 5s, 15s, then fail; max 4 attempts).
const BACKOFF_MS = [2000, 5000, 15000];
// Random 0..JITTER_MS added to each backoff so a synchronized 429 burst
// retries on staggered schedules instead of in lockstep.
const JITTER_MS = 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function jitteredBackoff(attempt: number): number {
  return BACKOFF_MS[attempt] + Math.floor(Math.random() * JITTER_MS);
}

// ---- global Langfuse concurrency limiter ----
//
// Every Langfuse call routes through one process-wide limiter so parallel
// pagination and concurrent cold endpoints can never exceed a few
// simultaneous requests and stampede the Hobby-tier rate limit. The cap is
// per serverless instance, which is the right scope: each Vercel instance
// has its own outbound connection budget, and a single-operator dashboard
// never has enough instances for that to matter.
const MAX_CONCURRENT_LANGFUSE = 3;

// Minimal FIFO counting semaphore. acquire() resolves a release fn once a
// slot is free; the release is idempotent so try/finally double-release is
// harmless.
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

const langfuseLimiter = new Semaphore(MAX_CONCURRENT_LANGFUSE);

// Run fn while holding one limiter slot; release on completion or throw.
async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  const release = await langfuseLimiter.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---- raw Langfuse shapes (subset we consume) ----

interface RawTrace {
  id: string;
  name: string;
  timestamp: string;
  tags: string[] | null;
  totalCost?: number | null;
  latency?: number | null; // seconds
  // Heavier fields — surfaced only via opsQueryRaw (Conversations / RAG /
  // Defense tabs), never in the lean OpsTrace the stats rollup caches.
  metadata?: Record<string, unknown> | null;
  input?: unknown;
  output?: unknown;
  htmlPath?: string | null;
  projectId?: string | null;
  scores?: unknown[] | null;
}

interface RawObservation {
  id: string;
  traceId: string;
  name?: string | null;
  model?: string | null;
  calculatedTotalCost?: number | null;
  latency?: number | null; // seconds
  startTime?: string | null;
}

interface ListResponse<T> {
  data: T[];
  meta?: { totalItems?: number; totalPages?: number };
}

// ---- normalized shapes returned to callers ----

// tags is always an array (never null) so downstream `.includes()` /
// realUser filters are safe.
export interface OpsTrace {
  id: string;
  name: string;
  timestamp: string;
  tags: string[];
  totalCost: number;
  latency: number; // seconds (Langfuse trace.latency)
}

export interface OpsObservation {
  id: string;
  traceId: string;
  name: string;
  model: string;
  calculatedTotalCost: number;
  latency: number; // seconds
  startTime: string;
}

// Richer trace shape for the Conversations / RAG / Defense tabs — carries
// metadata + input/output previews + the Langfuse deep-link path. Kept
// separate from OpsTrace so the stats rollup cache stays small.
export interface OpsRawTrace {
  id: string;
  name: string;
  timestamp: string;
  tags: string[];
  totalCost: number;
  latency: number; // seconds
  metadata: Record<string, unknown>;
  input: unknown;
  output: unknown;
  htmlPath: string | null;
  projectId: string | null;
  scores: unknown[];
}

export interface OpsQueryOptions {
  // Size of the rolling window, in days, ending now.
  windowDays: number;
  // When false (default), eval-source traffic is excluded so the
  // count matches the cost script's real-user denominator. Pass true
  // for the cost script's "all kept" / HUD-compare view.
  includeEvals?: boolean;
  // Override the window end (defaults to now). Tests inject a fixed
  // Date; production omits it.
  now?: Date;
}

export interface OpsQueryResult {
  traces: OpsTrace[];
  count: number;
}

// ---- fetch helpers ----

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return 'Basic ' + btoa(`${publicKey}:${secretKey}`);
}

// Resolve Langfuse creds from env into a base URL + auth header, or
// throw. Shared by opsQuery + opsObservations so the credential check
// lives in one place.
function resolveLangfuse(): { baseUrl: string; authHeader: string } {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set');
  }
  const baseUrl = (process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return { baseUrl, authHeader: basicAuthHeader(publicKey, secretKey) };
}

// GET with 429 backoff, through the global limiter. Returns parsed JSON;
// non-429 errors throw immediately. The limiter slot is held only for the
// fetch+parse, then RELEASED during the backoff sleep so a stalled retry
// never blocks other Langfuse calls.
async function langfuseGet<T>(url: string, authHeader: string): Promise<T> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const result = await runLimited(
      async (): Promise<{ kind: 'ok'; json: T } | { kind: 'rate-limited' }> => {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: authHeader, Accept: 'application/json' },
        });
        if (res.status === 429) return { kind: 'rate-limited' };
        if (!res.ok) {
          throw new Error(
            `langfuse ${new URL(url).pathname} returned ${res.status}`,
          );
        }
        return { kind: 'ok', json: (await res.json()) as T };
      },
    );
    if (result.kind === 'ok') return result.json;
    if (attempt < BACKOFF_MS.length) {
      await sleep(jitteredBackoff(attempt));
      continue;
    }
  }
  throw new Error('langfuse request exhausted 429 retries');
}

// Fully paginated list fetch. Fetches page 1 to learn meta.totalPages, then
// pulls pages 2..N in PARALLEL through the global limiter (so ~N serial
// round-trips collapse into ~ceil(N/3) waves). When Langfuse omits
// totalPages it falls back to serial short-page detection. THROWS rather
// than returning a truncated result if the window exceeds MAX_PAGES.
async function paginate<T>(
  buildUrl: (page: number) => string,
  authHeader: string,
): Promise<T[]> {
  const first = await langfuseGet<ListResponse<T>>(buildUrl(1), authHeader);
  const all: T[] = [...(first.data ?? [])];
  const totalPages = first.meta?.totalPages;

  // Serial fallback: no page count, so stop on the first short page.
  if (typeof totalPages !== 'number') {
    if ((first.data?.length ?? 0) < PAGE_LIMIT) return all;
    let page = 2;
    for (; page <= MAX_PAGES; page++) {
      const body = await langfuseGet<ListResponse<T>>(
        buildUrl(page),
        authHeader,
      );
      const items = body.data ?? [];
      all.push(...items);
      if (items.length < PAGE_LIMIT) break;
    }
    if (page > MAX_PAGES) {
      throw new Error(
        `opsQuery: window exceeded ${MAX_PAGES * PAGE_LIMIT}-item cap, refusing to return a truncated result`,
      );
    }
    return all;
  }

  // Known total: cap-guard up front (before fetching the rest), then pull
  // pages 2..totalPages in parallel. Promise.all preserves page order.
  if (totalPages > MAX_PAGES) {
    throw new Error(
      `opsQuery: window has ${totalPages} pages, exceeds the ${MAX_PAGES}-page cap, refusing to return a truncated result`,
    );
  }
  if (totalPages <= 1) return all;

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      langfuseGet<ListResponse<T>>(buildUrl(i + 2), authHeader),
    ),
  );
  for (const body of rest) all.push(...(body.data ?? []));
  return all;
}

function windowIso(
  now: Date,
  windowDays: number,
): { fromIso: string; toIso: string } {
  return {
    toIso: now.toISOString(),
    fromIso: new Date(
      now.getTime() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };
}

// ---- public API ----

// Fully paginated, eval-aware trace fetch for the window.
export async function opsQuery(opts: OpsQueryOptions): Promise<OpsQueryResult> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const now = opts.now ?? new Date();
  const { fromIso, toIso } = windowIso(now, opts.windowDays);
  const includeEvals = opts.includeEvals ?? false;

  const raw = await paginate<RawTrace>((page) => {
    const qs = new URLSearchParams({
      name: TRACE_NAME,
      fromTimestamp: fromIso,
      toTimestamp: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    return `${baseUrl}/api/public/traces?${qs.toString()}`;
  }, authHeader);

  const traces: OpsTrace[] = raw
    .map((t) => ({
      id: t.id,
      name: t.name,
      timestamp: t.timestamp,
      tags: t.tags ?? [],
      totalCost: t.totalCost ?? 0,
      latency: t.latency ?? 0,
    }))
    .filter((t) => includeEvals || !t.tags.includes(EVAL_SOURCE_TAG));

  return { traces, count: traces.length };
}

// Like opsQuery but returns the richer raw trace (metadata + previews +
// Langfuse deep-link). Same eval-source exclusion. Used by the tabs that
// need more than the lean rollup shape.
export async function opsQueryRaw(
  opts: OpsQueryOptions,
): Promise<OpsRawTrace[]> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const now = opts.now ?? new Date();
  const { fromIso, toIso } = windowIso(now, opts.windowDays);
  const includeEvals = opts.includeEvals ?? false;

  const raw = await paginate<RawTrace>((page) => {
    const qs = new URLSearchParams({
      name: TRACE_NAME,
      fromTimestamp: fromIso,
      toTimestamp: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    return `${baseUrl}/api/public/traces?${qs.toString()}`;
  }, authHeader);

  return raw
    .map((t) => ({
      id: t.id,
      name: t.name,
      timestamp: t.timestamp,
      tags: t.tags ?? [],
      totalCost: t.totalCost ?? 0,
      latency: t.latency ?? 0,
      metadata: t.metadata ?? {},
      input: t.input ?? null,
      output: t.output ?? null,
      htmlPath: t.htmlPath ?? null,
      projectId: t.projectId ?? null,
      scores: t.scores ?? [],
    }))
    .filter((t) => includeEvals || !t.tags.includes(EVAL_SOURCE_TAG));
}

// Fetch a single trace's detail: the trace plus its observations and
// scores, in parallel. Returns null pieces tolerated by callers.
export async function opsTraceById(id: string): Promise<{
  trace: OpsRawTrace | null;
  observations: OpsObservation[];
  scores: unknown[];
}> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const enc = encodeURIComponent(id);
  const [traceRaw, obsRaw, scoreRaw] = await Promise.all([
    langfuseGet<RawTrace>(`${baseUrl}/api/public/traces/${enc}`, authHeader),
    langfuseGet<ListResponse<RawObservation>>(
      `${baseUrl}/api/public/observations?traceId=${enc}&limit=${PAGE_LIMIT}`,
      authHeader,
    ),
    langfuseGet<ListResponse<unknown>>(
      `${baseUrl}/api/public/scores?traceId=${enc}&limit=${PAGE_LIMIT}`,
      authHeader,
    ),
  ]);

  const trace: OpsRawTrace | null = traceRaw
    ? {
        id: traceRaw.id,
        name: traceRaw.name,
        timestamp: traceRaw.timestamp,
        tags: traceRaw.tags ?? [],
        totalCost: traceRaw.totalCost ?? 0,
        latency: traceRaw.latency ?? 0,
        metadata: traceRaw.metadata ?? {},
        input: traceRaw.input ?? null,
        output: traceRaw.output ?? null,
        htmlPath: traceRaw.htmlPath ?? null,
        projectId: traceRaw.projectId ?? null,
        scores: traceRaw.scores ?? [],
      }
    : null;

  const observations = (obsRaw.data ?? []).map((o) => ({
    id: o.id,
    traceId: o.traceId,
    name: o.name ?? '',
    model: o.model ?? '',
    calculatedTotalCost: o.calculatedTotalCost ?? 0,
    latency: o.latency ?? 0,
    startTime: o.startTime ?? '',
  }));

  return { trace, observations, scores: scoreRaw.data ?? [] };
}

// Fully paginated GENERATION-observation fetch for the window. Returns
// ALL generations in the window (not scoped to chat-turn — there's no
// observation-side trace-name filter); callers bin by traceId against
// the trace set they care about.
export async function opsObservations(opts: {
  windowDays: number;
  now?: Date;
}): Promise<OpsObservation[]> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const now = opts.now ?? new Date();
  const { fromIso, toIso } = windowIso(now, opts.windowDays);

  const raw = await paginate<RawObservation>((page) => {
    const qs = new URLSearchParams({
      type: 'GENERATION',
      fromStartTime: fromIso,
      toStartTime: toIso,
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    return `${baseUrl}/api/public/observations?${qs.toString()}`;
  }, authHeader);

  return raw.map((o) => ({
    id: o.id,
    traceId: o.traceId,
    name: o.name ?? '',
    model: o.model ?? '',
    calculatedTotalCost: o.calculatedTotalCost ?? 0,
    latency: o.latency ?? 0,
    startTime: o.startTime ?? '',
  }));
}

// Real-human filter: drops defense/error-tagged traces (injection-detected,
// rate-limited, streamed-error). Pure and synchronous — operates on traces
// already fetched by opsQuery, so it's testable without any network mock.
//
// It does NOT touch eval-source; that exclusion is opsQuery's job (pass
// includeEvals:false). Compose for a real-human count:
//   realUser((await opsQuery({ windowDays, includeEvals:false })).traces).length
export function realUser<T extends { tags: string[] }>(traces: T[]): T[] {
  // Generic over anything carrying `tags` (OpsTrace and OpsRawTrace both
  // qualify). `?? []` is defensive: opsQuery always normalizes tags to an
  // array, but callers may pass traces deserialized from an older on-disk
  // cache (scripts/cost/measure.ts) where a tagless trace was stored as null.
  return traces.filter(
    (t) => !(t.tags ?? []).some((tag) => DEFENSE_TAGS.has(tag)),
  );
}

// Apply the eval-source axis on top of already-fetched traces. Same
// exclusion opsQuery does inline, but composable over getWindowRaw's
// unfiltered raw. includeEvals:true keeps everything.
export function applyEvalScope<T extends { tags: string[] }>(
  traces: T[],
  includeEvals: boolean,
): T[] {
  return includeEvals
    ? traces
    : traces.filter((t) => !t.tags.includes(EVAL_SOURCE_TAG));
}

// ---- shared raw window cache + single-flight ----

// All traces (eval-source INCLUDED) + all generation observations for a
// window, before any eval/realUser/defense scoping. One pull serves stats,
// rag, defense, and conversations across both test-traffic states, so the
// four endpoints stop independently re-sweeping the same window from Langfuse.
export interface WindowRaw {
  traces: OpsRawTrace[];
  observations: OpsObservation[];
}

// Minimal Upstash surface, structurally satisfied by the @upstash/redis
// client the handlers already build (same shape as OpsStatsRedis).
export interface RawWindowCache {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
}

const WINDOW_RAW_TTL_SECONDS = 5 * 60;

// Per-instance single-flight: concurrent cold callers in the SAME serverless
// instance coalesce onto one in-flight fetch. This dedupes per-instance,
// which is right-sized for a single-operator dashboard; a distributed lock
// across instances would be overkill (cross-instance callers still share via
// the Upstash blob a beat later).
const rawInFlight = new Map<string, Promise<WindowRaw>>();

// Window-scoped raw fetch with two-layer dedupe: warm Upstash blob first,
// then per-instance single-flight, then one Langfuse sweep. Keyed on the
// window only (not includeEvals) so both test-traffic states share it.
export async function getWindowRaw(
  redis: RawWindowCache,
  windowDays: number,
  now: Date = new Date(),
): Promise<WindowRaw> {
  const key = `ops:raw:${windowDays}`;

  // 1. Warm Upstash blob?
  try {
    const hit = await redis.get<WindowRaw>(key);
    if (hit && typeof hit === 'object') return hit;
  } catch (err) {
    console.error('[ops] raw window cache GET failed:', key, err);
  }

  // 2. An in-flight fetch for this window in this instance? Join it.
  const existing = rawInFlight.get(key);
  if (existing) return existing;

  // 3. Lead the fetch. includeEvals:true => no eval filtering here; callers
  //    scope with applyEvalScope/realUser on top of the shared raw.
  const promise = (async (): Promise<WindowRaw> => {
    const [traces, observations] = await Promise.all([
      opsQueryRaw({ windowDays, includeEvals: true, now }),
      opsObservations({ windowDays, now }),
    ]);
    return { traces, observations };
  })();
  rawInFlight.set(key, promise);

  try {
    const data = await promise;
    try {
      await redis.set(key, data, { ex: WINDOW_RAW_TTL_SECONDS });
    } catch (err) {
      console.error('[ops] raw window cache SET failed:', key, err);
    }
    return data;
  } finally {
    rawInFlight.delete(key);
  }
}
