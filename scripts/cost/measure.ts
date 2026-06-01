// Per-turn cost measurement (M3 Phase 6). Refreshes the numbers in
// README.md's `### Per-turn cost` subsection from current Langfuse
// data. Run via `npm run cost:measure`.
//
// Scope: per-turn cost ONLY. The README's separate `### Prompt
// caching` subsection comes from a controlled two-turn measurement
// (not aggregate trace data) and is NOT regenerated here.
//
// ---- Why bulk pagination, not per-trace fetches ----
// Earlier versions fetched observations per trace via
// /api/public/observations?traceId=<id>. That breaks on the Hobby
// tier: Langfuse rate-limits per-trace fetches and ~80% of requests
// returned HTTP 429 above a few dozen traces. This script uses
// /api/public/traces (paginated trace list, gives totalCost +
// tags + timestamp) plus /api/public/observations with
// fromStartTime (single paginated sweep over all generations in the
// window) and bins observations by trace id in memory. One pass
// fetches everything the report needs.
//
// ---- Caching ----
// Raw Langfuse payloads are cached at scripts/cost/.cache/<date>-30d.json
// (gitignored). Same-day re-runs hit disk, not the API. Set
// COST_MEASURE_NO_CACHE=1 to force a fresh fetch.
//
// ---- Exit codes ----
// 0 — all stats computed, HUD sanity check within tolerance
// 1 — HUD sanity check diverged >20% from HUD_REFERENCE_AVG_USD
//     (defaults to $0.01074, the 2026-06-01 HUD snapshot the spec
//      anchored against)
// 2 — fatal error (missing env, Langfuse unreachable after retries)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const BASE_URL =
  process.env.LANGFUSE_BASE_URL ?? 'https://jp.cloud.langfuse.com';

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.error(
    '[cost:measure] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — run via `npm run cost:measure` so dotenv-cli loads .env.local',
  );
  process.exit(2);
}

const AUTH = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}`;

// HUD sanity-check reference. The HUD on the live site displays a
// 7-day rolling cost-per-turn. The 30d kept-trace avg this script
// computes must stay within ±20% of that value; otherwise something
// is wrong (filter bug, observation-binning bug, or upstream Langfuse
// regression). Override via env when the HUD's headline shifts
// materially.
const HUD_REF = Number.parseFloat(
  process.env.HUD_REFERENCE_AVG_USD ?? '0.01074',
);
const HUD_TOLERANCE = 0.2;

const WINDOW_DAYS = 30;
const CACHE_DIR = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '.cache',
);

// ---- Langfuse fetch helpers ----

type Trace = {
  id: string;
  name: string;
  timestamp: string;
  tags: string[] | null;
  totalCost?: number;
};

type Observation = {
  id: string;
  traceId: string;
  type: 'GENERATION' | 'SPAN' | 'EVENT';
  name: string | null;
  model: string | null;
  calculatedTotalCost: number | null;
  startTime: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff: 2s → 5s → 15s → fail. Max 4 retries.
const BACKOFF_MS = [2000, 5000, 15000];

async function fetchJson<T>(url: URL): Promise<T> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: AUTH } });
    if (resp.status === 429 && attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[attempt];
      console.error(`[cost:measure] 429 on ${url.pathname}; backoff ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) {
      throw new Error(`${url.pathname} HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  }
  throw new Error(`exhausted retries on ${url.pathname}`);
}

async function listAllTraces(from: Date): Promise<Trace[]> {
  const all: Trace[] = [];
  let page = 1;
  while (true) {
    const url = new URL(`${BASE_URL}/api/public/traces`);
    url.searchParams.set('name', 'chat-turn');
    url.searchParams.set('fromTimestamp', from.toISOString());
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', '100');
    const body = await fetchJson<{
      data: Trace[];
      meta: { totalPages: number };
    }>(url);
    all.push(...body.data);
    if (page >= body.meta.totalPages) break;
    page++;
    await sleep(150);
  }
  return all;
}

async function listAllObservations(from: Date): Promise<Observation[]> {
  const all: Observation[] = [];
  let page = 1;
  while (true) {
    const url = new URL(`${BASE_URL}/api/public/observations`);
    url.searchParams.set('type', 'GENERATION');
    url.searchParams.set('fromStartTime', from.toISOString());
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', '100');
    const body = await fetchJson<{
      data: Observation[];
      meta: { totalPages: number };
    }>(url);
    all.push(...body.data);
    if (page >= body.meta.totalPages) break;
    page++;
    await sleep(150);
  }
  return all;
}

// ---- Cache ----

type CachedPayload = {
  fetchedAt: string;
  windowDays: number;
  from: string;
  traces: Trace[];
  observations: Observation[];
};

function cacheFilePath(windowFrom: Date): string {
  const dayStr = windowFrom.toISOString().slice(0, 10);
  return resolvePath(CACHE_DIR, `${dayStr}-${WINDOW_DAYS}d.json`);
}

async function loadCache(windowFrom: Date): Promise<CachedPayload | null> {
  if (process.env.COST_MEASURE_NO_CACHE === '1') return null;
  const path = cacheFilePath(windowFrom);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as CachedPayload;
  } catch {
    return null;
  }
}

async function saveCache(payload: CachedPayload): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    cacheFilePath(new Date(payload.from)),
    JSON.stringify(payload),
  );
}

// ---- Stats ----

type Bucket = {
  traceId: string;
  timestamp: string;
  tags: string[];
  total: number;
  sonnet: number;
  embedding: number;
  rerank: number;
  retrievalFired: boolean;
};

const EXCLUDE_TAGS = new Set([
  'rate-limited',
  'injection-detected',
  'streamed-error',
]);

function buildBuckets(
  traces: Trace[],
  observations: Observation[],
): { buckets: Bucket[]; refusedEarly: number; noObs: number } {
  const obsByTrace = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.type !== 'GENERATION') continue;
    const list = obsByTrace.get(o.traceId) ?? [];
    list.push(o);
    obsByTrace.set(o.traceId, list);
  }

  let refusedEarly = 0;
  let noObs = 0;
  const buckets: Bucket[] = [];

  for (const t of traces) {
    const tags = t.tags ?? [];
    if (tags.some((tag) => EXCLUDE_TAGS.has(tag))) {
      refusedEarly++;
      continue;
    }
    const obs = obsByTrace.get(t.id) ?? [];
    if (obs.length === 0) {
      noObs++;
      continue;
    }
    let sonnet = 0;
    let embedding = 0;
    let rerank = 0;
    let retrievalFired = false;
    for (const o of obs) {
      const cost = o.calculatedTotalCost ?? 0;
      const name = o.name ?? '';
      // Sonnet bucketing rule. `anthropic_first_call` and
      // `anthropic_second_call` are the current naming for the
      // tool_use-decision + post-tool-call generations.
      // `sonnet-response` is a legacy single-call name from earlier
      // chat.ts iterations — same model, same role, kept folded into
      // Sonnet so historical traces aren't dropped from the bucket
      // and the README doesn't carry an unexplained "other" line.
      if (name.startsWith('anthropic_') || name === 'sonnet-response') {
        sonnet += cost;
      } else if (name === 'embedding') {
        embedding += cost;
        retrievalFired = true;
      } else if (name === 'rerank') {
        rerank += cost;
        retrievalFired = true;
      }
      // Anything else (e.g. ingestion-time haiku-readme-summary) is
      // not on the chat hot path. Ignored — these obs are typically
      // not under chat-turn traces anyway, but defensive.
    }
    buckets.push({
      traceId: t.id,
      timestamp: t.timestamp,
      tags,
      total: sonnet + embedding + rerank,
      sonnet,
      embedding,
      rerank,
      retrievalFired,
    });
  }
  return { buckets, refusedEarly, noObs };
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const pct = (n: number, d: number) =>
  d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`;
const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : sorted[
        Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
      ];

function summarize(label: string, b: Bucket[]) {
  const n = b.length;
  if (n === 0) {
    console.log(`---- ${label} (n=0) ----`);
    return;
  }
  const sumTotal = b.reduce((a, x) => a + x.total, 0);
  const sumS = b.reduce((a, x) => a + x.sonnet, 0);
  const sumE = b.reduce((a, x) => a + x.embedding, 0);
  const sumR = b.reduce((a, x) => a + x.rerank, 0);
  const sorted = b.map((x) => x.total).sort((a, b) => a - b);
  const fired = b.filter((x) => x.retrievalFired);
  const skipped = b.filter((x) => !x.retrievalFired);
  const avgFired = fired.length
    ? fired.reduce((a, x) => a + x.total, 0) / fired.length
    : 0;
  const avgSkipped = skipped.length
    ? skipped.reduce((a, x) => a + x.total, 0) / skipped.length
    : 0;
  console.log('');
  console.log(`---- ${label} (n=${n}) ----`);
  console.log(
    `avg ${usd(sumTotal / n)} · p50 ${usd(percentile(sorted, 50))} · p95 ${usd(percentile(sorted, 95))} · total ${usd(sumTotal)}`,
  );
  console.log(
    `retrieval fired n=${fired.length} (${pct(fired.length, n)}) avg ${usd(avgFired)}`,
  );
  console.log(
    `retrieval skipped n=${skipped.length} (${pct(skipped.length, n)}) avg ${usd(avgSkipped)}`,
  );
  console.log(
    `components — Sonnet ${pct(sumS, sumTotal)} · Haiku ${pct(sumR, sumTotal)} · Voyage ${pct(sumE, sumTotal)}`,
  );
}

(async () => {
  const from = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const cached = await loadCache(from);
  let traces: Trace[];
  let observations: Observation[];
  if (cached) {
    console.error(`[cost:measure] cache hit ${cacheFilePath(from)}`);
    traces = cached.traces;
    observations = cached.observations;
  } else {
    console.error(
      `[cost:measure] fetching traces + observations since ${from.toISOString()}`,
    );
    traces = await listAllTraces(from);
    observations = await listAllObservations(from);
    await saveCache({
      fetchedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      from: from.toISOString(),
      traces,
      observations,
    });
  }

  const { buckets, refusedEarly, noObs } = buildBuckets(traces, observations);

  console.log('');
  console.log('===== INVENTORY =====');
  console.log(`total chat-turn traces (30d):      ${traces.length}`);
  console.log(`  refused-early (excluded):        ${refusedEarly}`);
  console.log(`  no observations linked:          ${noObs}`);
  console.log(`  buckets built:                   ${buckets.length}`);

  const realUser = buckets.filter((b) => !b.tags.includes('eval-source'));
  const evalSource = buckets.filter((b) => b.tags.includes('eval-source'));

  console.log('');
  console.log('===== KEPT-TRACE COST STATS, 30d window =====');
  summarize('Real-user (eval-bypass excluded — README headline)', realUser);
  summarize('All kept (real-user + eval-source — for HUD compare)', buckets);
  summarize('Eval-source only (reference)', evalSource);

  // HUD sanity check — 7d slice
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sevenDay = buckets.filter((b) => new Date(b.timestamp) >= sevenDaysAgo);
  const sevenDayTotal = sevenDay.reduce((a, x) => a + x.total, 0);
  const sevenDayAvg = sevenDay.length ? sevenDayTotal / sevenDay.length : 0;

  console.log('');
  console.log('===== HUD SANITY CHECK =====');
  console.log(`7d kept-trace count:               ${sevenDay.length}`);
  console.log(`7d total cost (kept):              ${usd(sevenDayTotal)}`);
  console.log(`7d avg cost/turn (kept):           ${usd(sevenDayAvg)}`);
  console.log(`HUD reference (anchor):            ${usd(HUD_REF)}`);
  const div = HUD_REF === 0 ? 0 : Math.abs(sevenDayAvg - HUD_REF) / HUD_REF;
  const divLabel =
    div <= HUD_TOLERANCE
      ? `OK (≤${HUD_TOLERANCE * 100}%)`
      : `OUT OF BAND (>${HUD_TOLERANCE * 100}%)`;
  console.log(
    `divergence vs HUD anchor:          ${(div * 100).toFixed(1)}%  ${divLabel}`,
  );

  // Monthly projection from real-user avg
  const realAvg = realUser.length
    ? realUser.reduce((a, x) => a + x.total, 0) / realUser.length
    : 0;
  const realDaily = realUser.length / WINDOW_DAYS;
  console.log('');
  console.log('===== MONTHLY PROJECTION (real-user basis) =====');
  console.log(`real-user avg cost/turn:           ${usd(realAvg)}`);
  console.log(`@   50 turns/day:                  ${usd(realAvg * 50 * 30)}`);
  console.log(`@  200 turns/day:                  ${usd(realAvg * 200 * 30)}`);
  console.log(`@ 1000 turns/day:                  ${usd(realAvg * 1000 * 30)}`);
  console.log(
    `actual current (~${realDaily.toFixed(1)}/day real-user): ${usd(realAvg * realDaily * 30)}`,
  );

  // ----- README paste block -----
  // Self-anchoring refresh artifact. Emit the `### Per-turn cost`
  // bullets with the current run's numbers and a measurement-end date
  // pulled from the window-end timestamp. When the README's numbers
  // get stale, run this script and replace the subsection wholesale
  // with the block below.
  const realFiredCount = realUser.filter((x) => x.retrievalFired).length;
  const realFiredAvg = realFiredCount
    ? realUser
        .filter((x) => x.retrievalFired)
        .reduce((a, x) => a + x.total, 0) / realFiredCount
    : 0;
  const realSkippedCount = realUser.length - realFiredCount;
  const realSkippedAvg = realSkippedCount
    ? realUser
        .filter((x) => !x.retrievalFired)
        .reduce((a, x) => a + x.total, 0) / realSkippedCount
    : 0;
  const realSumS = realUser.reduce((a, x) => a + x.sonnet, 0);
  const realSumR = realUser.reduce((a, x) => a + x.rerank, 0);
  const realSumTotal = realUser.reduce((a, x) => a + x.total, 0);
  const sonnetPct = realSumTotal
    ? ((realSumS / realSumTotal) * 100).toFixed(0)
    : '0';
  const haikuPct = realSumTotal
    ? ((realSumR / realSumTotal) * 100).toFixed(0)
    : '0';
  // Window-end date = today's UTC date when this script runs. Same
  // anchor the cache key uses for its window-start; "ending YYYY-MM-DD"
  // gives the reader an absolute reference rather than a relative one
  // that goes stale silently.
  const windowEnd = new Date().toISOString().slice(0, 10);
  const dollarAvg = realAvg.toFixed(3);
  const dollarFired = realFiredAvg.toFixed(3);
  const dollarSkipped = realSkippedAvg.toFixed(3);
  const m50 = (realAvg * 50 * 30).toFixed(0);
  const m200 = (realAvg * 200 * 30).toFixed(0);
  const m1000 = (realAvg * 1000 * 30).toFixed(0);
  const mActual = (realAvg * realDaily * 30).toFixed(2);
  const firedRate = ((realFiredCount / realUser.length) * 100).toFixed(1);
  console.log('');
  console.log(
    '===== README BULLETS (paste to refresh `### Per-turn cost`) =====',
  );
  console.log('');
  console.log(
    `- **~$${dollarAvg} per chat turn** at production traffic. Sonnet 4.6 (tool_use decision + streaming generation) accounts for ~${sonnetPct}% of cost; Haiku 4.5 reranking the other ~${haikuPct}%; Voyage embeddings round to <0.01%. Measured over ${realUser.length} real-user production traces in the ${WINDOW_DAYS} days ending ${windowEnd}; eval-source CI traffic excluded.`,
  );
  console.log(
    `- **Cost shape depends on RAG firing.** Retrieval fires on ${firedRate}% of real-user turns; those cost ~$${dollarFired}. Skipped-retrieval turns cost ~$${dollarSkipped}. The delta is the Haiku rerank pass + the Voyage embed round-trip.`,
  );
  console.log(
    `- **~$${m200}/month at 200 turns/day** projected, scaling linearly with no fixed model overhead. 50 turns/day → ~$${m50}/month; 1,000 turns/day → ~$${m1000}/month. Current real-user traffic (~${realDaily.toFixed(1)}/day) projects to ~$${mActual}/month.`,
  );

  if (div > HUD_TOLERANCE) {
    console.error(
      `\n[cost:measure] FAIL — HUD divergence ${(div * 100).toFixed(1)}% exceeds ±${HUD_TOLERANCE * 100}% tolerance.`,
    );
    console.error(
      'Either the script binning drifted from production behavior, or the HUD anchor in HUD_REFERENCE_AVG_USD is stale.',
    );
    process.exit(1);
  }
})().catch((err) => {
  console.error('[cost:measure]', err);
  process.exit(2);
});
