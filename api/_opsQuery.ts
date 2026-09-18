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
// Observations API v2 raises the page ceiling from 100 to 1,000. Measured
// against the real project, a 30-DAY window is 468 rows — a single page,
// with no cursor returned. The v1 page-parallel machinery (and its
// MAX_PAGES truncation guard) existed to collapse ~3 serial round-trips at
// limit=100; at limit=1000 there is nothing left to parallelise, so it was
// removed rather than adapted. v2 pagination is cursor-based and therefore
// inherently serial: page N+1 needs page N's cursor.
const PAGE_LIMIT = 1000;

// Field groups. v2 omits any field whose group was not requested (absent,
// not null), so each call site asks for exactly what it consumes:
//   core          id/traceId/parent/type/name/startTime/endTime
//   basic         level/latency/cost/model
//   io            input/output (RAW STRINGS in v2 — v1 auto-parsed JSON)
//   trace_context traceName/tags/userId/sessionId
//   metadata      the rag_* trace metadata the RAG tab reads
//   usage         token counts AND totalCost — cost is NOT in `basic`.
//                 Omitting it makes every cost silently 0 (the field is
//                 absent, `?? 0` fills in, nothing throws). The parity
//                 harness caught exactly this.
const FIELDS_TRACE_LIST = 'core,basic,io,trace_context,metadata,usage';
const FIELDS_OBSERVATIONS = 'core,basic,trace_context,usage';

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

// One row from GET /v2/observations. v4 is observations-first: there is no
// trace object any more, so a "trace" is reconstructed by grouping rows on
// traceId and reading trace-level fields off the ROOT row
// (parentObservationId == null).
interface V2Row {
  id: string;
  traceId: string;
  parentObservationId?: string | null;
  type?: string | null;
  name?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  level?: string | null;
  model?: string | null;
  // NOTE: v1 called this `calculatedTotalCost`. The rename is silent — a
  // stale read yields undefined, then `?? 0`, and costs become zero without
  // throwing. The parity harness diffs total cost per window to catch it.
  totalCost?: number | null;
  latency?: number | null; // seconds (same unit as v1 trace.latency)
  // RAW STRINGS in v2; v1 handed back parsed JSON.
  input?: string | null;
  output?: string | null;
  // trace_context group — trace-level attributes joined onto each row.
  traceName?: string | null;
  tags?: string[] | null;
  projectId?: string | null;
  // metadata group
  metadata?: Record<string, unknown> | null;
}

interface ListResponse<T> {
  data: T[];
  meta?: { cursor?: string | null };
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

// Fully paginated cursor fetch. v2 pagination is serial by construction —
// page N+1 needs the cursor returned by page N — so there is no parallel
// variant to keep. At limit=1000 this loop almost always runs exactly once
// for our real windows.
async function paginateV2(
  buildUrl: (cursor: string | null) => string,
  authHeader: string,
): Promise<V2Row[]> {
  const all: V2Row[] = [];
  let cursor: string | null = null;
  // Runaway guard only: a window would need >1,000,000 rows to reach this.
  for (let page = 0; page < 1000; page++) {
    const body: ListResponse<V2Row> = await langfuseGet<ListResponse<V2Row>>(
      buildUrl(cursor),
      authHeader,
    );
    all.push(...(body.data ?? []));
    cursor = body.meta?.cursor ?? null;
    if (!cursor) return all;
  }
  throw new Error('opsQuery: cursor pagination did not terminate');
}

// v2 returns input/output as raw strings; v1 auto-parsed JSON. Downstream
// consumers (questionText/answerText in _opsConversations) branch on
// object-vs-string, so handing them an unparsed JSON string would render
// the literal `{"q":"..."}` to the operator. Parse when it looks like JSON,
// otherwise pass the plain string through unchanged.
function parseIo(value: string | null | undefined): unknown {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[[{"]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Trace latency, in seconds.
//
// The root row carries `latency` for traces written by the v5 OTEL SDK
// (verified 68/68). Traces ingested by the legacy v3 SDK were backfilled
// server-side into the observations model WITHOUT an endTime on their
// synthesized root (0/200 carry latency), so for those we derive the span
// from the widest start/end across the trace's rows. Legacy traces age out
// of every window within 30 days, after which this fallback is dead weight
// and can be deleted.
function traceLatencySeconds(rows: V2Row[], root: V2Row | undefined): number {
  if (root && typeof root.latency === 'number') return root.latency;
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.startTime) min = Math.min(min, Date.parse(r.startTime));
    if (r.endTime) max = Math.max(max, Date.parse(r.endTime));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return (max - min) / 1000;
}

// Group v2 observation rows into trace-shaped records.
//
// Trace-level fields come from the ROOT row; totalCost is summed across
// every row in the trace (v1's trace.totalCost was the same roll-up).
// Rows whose trace has no root row are dropped: without a root there is no
// input/output/tags to reconstruct from.
function groupIntoTraces(rows: V2Row[]): OpsRawTrace[] {
  const byTrace = new Map<string, V2Row[]>();
  for (const r of rows) {
    const list = byTrace.get(r.traceId);
    if (list) list.push(r);
    else byTrace.set(r.traceId, [r]);
  }

  const out: OpsRawTrace[] = [];
  for (const [traceId, group] of byTrace) {
    const root = group.find((r) => !r.parentObservationId);
    if (!root) continue;
    let totalCost = 0;
    for (const r of group) totalCost += r.totalCost ?? 0;
    out.push({
      id: traceId,
      name: root.traceName ?? root.name ?? '',
      timestamp: root.startTime ?? '',
      tags: root.tags ?? [],
      totalCost,
      latency: traceLatencySeconds(group, root),
      metadata: root.metadata ?? {},
      input: parseIo(root.input),
      output: parseIo(root.output),
      htmlPath: null,
      projectId: root.projectId ?? null,
    });
  }

  // v2 has no orderBy; rows arrive startTime DESC but grouping does not
  // preserve that, so sort explicitly. v1 returned traces newest-first.
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}

// Shared URL builder for a window-scoped /v2/observations sweep.
function v2WindowUrl(
  baseUrl: string,
  fromIso: string,
  toIso: string,
  fields: string,
  cursor: string | null,
  extra?: Record<string, string>,
): string {
  const qs = new URLSearchParams({
    fromStartTime: fromIso,
    toStartTime: toIso,
    fields,
    limit: String(PAGE_LIMIT),
    ...(extra ?? {}),
  });
  if (cursor) qs.set('cursor', cursor);
  return `${baseUrl}/api/public/v2/observations?${qs.toString()}`;
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
  const raw = await opsQueryRaw(opts);
  const traces: OpsTrace[] = raw.map((t) => ({
    id: t.id,
    name: t.name,
    timestamp: t.timestamp,
    tags: t.tags,
    totalCost: t.totalCost,
    latency: t.latency,
  }));
  return { traces, count: traces.length };
}

// Like opsQuery but returns the richer raw trace (metadata + previews +
// Langfuse deep-link). Same eval-source exclusion. Used by the tabs that
// need more than the lean rollup shape.
//
// The eval-source filter runs AFTER grouping, against the ROOT row's tags.
// v2 joins trace-level tags onto every row, but not consistently (59 of 235
// traces in a 7d sample disagreed between root and children), so the root is
// the single source of truth — and it matches v1's trace-level semantics.
export async function opsQueryRaw(
  opts: OpsQueryOptions,
): Promise<OpsRawTrace[]> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const now = opts.now ?? new Date();
  const { fromIso, toIso } = windowIso(now, opts.windowDays);
  const includeEvals = opts.includeEvals ?? false;

  const rows = await paginateV2(
    (cursor) => v2WindowUrl(baseUrl, fromIso, toIso, FIELDS_TRACE_LIST, cursor),
    authHeader,
  );

  return groupIntoTraces(rows)
    .filter((t) => t.name === TRACE_NAME)
    .filter((t) => includeEvals || !t.tags.includes(EVAL_SOURCE_TAG));
}

// Fetch a single trace's detail: the trace plus its observations.
//
// v1 needed three calls (trace + observations + scores); v2 needs one —
// every row of the trace comes back together, and the root row carries the
// trace-level fields. The /scores call was dropped outright rather than
// ported to /v3/scores: this project has never written a score
// (GET /v2/scores reports 0 items) and no UI surface rendered them.
export async function opsTraceById(id: string): Promise<{
  trace: OpsRawTrace | null;
  observations: OpsObservation[];
}> {
  const { baseUrl, authHeader } = resolveLangfuse();
  const qs = new URLSearchParams({
    traceId: id,
    fields: FIELDS_TRACE_LIST,
    limit: String(PAGE_LIMIT),
  });
  const rows = await paginateV2((cursor) => {
    const q = new URLSearchParams(qs);
    if (cursor) q.set('cursor', cursor);
    return `${baseUrl}/api/public/v2/observations?${q.toString()}`;
  }, authHeader);

  const trace = groupIntoTraces(rows)[0] ?? null;
  const observations = rows
    .filter((o) => o.type === 'GENERATION')
    .map(toOpsObservation);

  return { trace, observations };
}

// Map a v2 row to the normalized observation shape. `totalCost` is v2's
// name for what v1 called `calculatedTotalCost`; the public OpsObservation
// field keeps the old name so downstream aggregation code is untouched.
function toOpsObservation(o: V2Row): OpsObservation {
  return {
    id: o.id,
    traceId: o.traceId,
    name: o.name ?? '',
    model: o.model ?? '',
    calculatedTotalCost: o.totalCost ?? 0,
    latency: o.latency ?? 0,
    startTime: o.startTime ?? '',
  };
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

  const rows = await paginateV2(
    (cursor) =>
      v2WindowUrl(baseUrl, fromIso, toIso, FIELDS_OBSERVATIONS, cursor, {
        type: 'GENERATION',
      }),
    authHeader,
  );

  return rows.map(toOpsObservation);
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
  // v2 bump: the cached blob's shape changed with the Observations v2
  // migration (reconstructed traces, renamed cost field, parsed I/O). Old
  // v1-shaped blobs would deserialize into subtly wrong objects, so the key
  // changes and stale entries simply expire within the 5-minute TTL.
  const key = `ops:raw:v2:${windowDays}`;

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
