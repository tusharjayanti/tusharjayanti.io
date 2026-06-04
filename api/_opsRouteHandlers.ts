// Handler bodies for the consolidated /api/ops dispatcher (api/ops/[...path].ts).
// Each function is a former api/ops/*.ts route handler, extracted verbatim
// MINUS the method check and (for data routes) the requireSession guard — the
// dispatcher owns routing, method validation, and the data-route auth guard.
// login/logout/me keep their own auth behavior. The _ops*.ts business modules
// are unchanged.
//
// Node serverless only (the dispatcher is Node, so evals' fs read works).

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from './_types.js';
import { parseBody } from './_compat.js';
import { hashIp, checkOpsLoginRateLimit } from './_kv.js';
import {
  verifyOpsPassword,
  issueSession,
  issueCookie,
  clearCookie,
  requireSession,
} from './_opsAuth.js';
import {
  getWindowRaw,
  applyEvalScope,
  realUser,
  opsObservations,
  opsTraceById,
} from './_opsQuery.js';
import {
  aggregateStats,
  getOpsStats,
  cacheAside,
  type OpsStatsRedis,
} from './_opsStats.js';
import {
  toListItem,
  paginateList,
  buildDetail,
  type ConversationListItem,
} from './_opsConversations.js';
import { ragStats, type IndexCount, type RagStatsData } from './_opsRag.js';
import { defenseStats, type DefenseData } from './_opsDefense.js';
import { assembleEvals, type EvalsData } from './_opsEvals.js';
import {
  headroomBar,
  summarizeRateLimits,
  type PromptInfo,
  type SystemData,
} from './_opsSystem.js';
import { getSupabaseClient } from './_supabase.js';
import {
  PROMPT_NAME,
  PROMPT_VERSION,
  PROMPT_VERSION_NUMBER,
  CANARY_TOKEN,
} from './_systemPrompt.js';
import type {
  EvalResult,
  BaselinePointer,
} from '../scripts/eval/result-writer.js';

const ALLOWED_WINDOWS = new Set([1, 7, 30]);
const CACHE_TTL_SECONDS = 5 * 60;
const EVALS_CACHE_TTL_SECONDS = 15 * 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const RATE_LIMIT_PER_IP = 40; // matches _kv.ts checkRateLimit
const LANGFUSE_OBS_MONTHLY_CAP = 50_000; // Hobby tier observation budget
const LANGFUSE_DEFAULT_BASE = 'https://jp.cloud.langfuse.com';

// ---- shared helpers ----

function windowParams(req: VercelRequest): {
  windowDays: number;
  includeEvals: boolean;
} {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wRaw = Number.parseInt(url.searchParams.get('windowDays') ?? '', 10);
  const windowDays = ALLOWED_WINDOWS.has(wRaw) ? wRaw : 7;
  const ie = url.searchParams.get('includeEvals');
  return { windowDays, includeEvals: ie === 'true' || ie === '1' };
}

function redisFromEnv(res: VercelResponse, tag: string): Redis | null {
  try {
    return Redis.fromEnv();
  } catch (err) {
    console.error(`[${tag}] Redis init failed:`, err);
    res.status(503).json({ error: 'redis unavailable' });
    return null;
  }
}

function sendCached(
  res: VercelResponse,
  data: unknown,
  cached: boolean,
  stale: boolean,
): void {
  res
    .setHeader('cache-control', 'no-store')
    .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
    .status(200)
    .json(data);
}

// ---- auth routes (own behavior; method enforced by the dispatcher) ----

export async function handleLogin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // Fail-closed if the operator hasn't configured the secrets — never
  // hand out a session signed with an absent key.
  if (!process.env.OPS_PASSWORD || !process.env.OPS_SESSION_SECRET) {
    res.status(503).json({ error: 'ops auth not configured' });
    return;
  }

  // Per-IP throttle. A Redis hiccup fails open (TLS + password still gate
  // the request); the throttle is brute-force friction, not the control.
  let ipHash = 'unknown';
  try {
    ipHash = await hashIp(req);
    const rl = await checkOpsLoginRateLimit(ipHash);
    if (!rl.ok) {
      res.status(429).json({ error: 'too many attempts, slow down' });
      return;
    }
  } catch (err) {
    console.error('[ops/login] rate-limit check failed:', err);
  }

  const body = (await parseBody(req)) as { password?: unknown } | null;
  if (!verifyOpsPassword(body?.password)) {
    res.status(401).json({ error: 'invalid password' });
    return;
  }

  res.setHeader('Set-Cookie', issueCookie(issueSession()));
  res.status(200).json({ ok: true });
}

export async function handleLogout(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Set-Cookie', clearCookie());
  res.status(200).json({ ok: true });
}

export async function handleMe(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const session = requireSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.status(200).json({ authenticated: true, exp: session.exp });
}

// ---- data routes (the dispatcher has already guarded requireSession) ----

export async function handleStats(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const { windowDays, includeEvals } = windowParams(req);
  const redis = redisFromEnv(res, 'ops/stats');
  if (!redis) return;
  const r = redis as unknown as OpsStatsRedis;

  const cacheKey = `ops:rollup:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await getOpsStats(
      r,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const now = new Date();
        const { traces, observations } = await getWindowRaw(r, windowDays, now);
        const kept = realUser(applyEvalScope(traces, includeEvals));
        return aggregateStats(kept, observations, {
          windowDays,
          includeEvals,
          now,
        });
      },
      { scheduleRefresh: waitUntil },
    );
    sendCached(res, data, cached, stale);
  } catch (err) {
    console.error('[ops/stats] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}

export async function handleTraces(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const { windowDays, includeEvals } = windowParams(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1,
  );
  const limRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Math.min(MAX_LIMIT, limRaw > 0 ? limRaw : DEFAULT_LIMIT);

  const redis = redisFromEnv(res, 'ops/traces');
  if (!redis) return;
  const r = redis as unknown as OpsStatsRedis;

  const cacheKey = `ops:conv:${windowDays}:${includeEvals}`;
  try {
    const { data: all, cached, stale } = await cacheAside<{
      items: ConversationListItem[];
    }>(
      r,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const { traces } = await getWindowRaw(r, windowDays);
        const items = realUser(applyEvalScope(traces, includeEvals))
          .map(toListItem)
          .sort((a, b) => b.ts.localeCompare(a.ts)); // newest first
        return { items };
      },
      { scheduleRefresh: waitUntil },
    );
    const result = paginateList(all.items, page, limit);
    sendCached(res, result, cached, stale);
  } catch (err) {
    console.error('[ops/traces] list failed:', err);
    res.status(502).json({ error: 'list failed' });
  }
}

async function fetchIndexCounts(): Promise<IndexCount[] | null> {
  try {
    const { data, error } = await getSupabaseClient().rpc('chunk_counts');
    if (error || !Array.isArray(data)) return null;
    return data.map((r: { source: string; chunks: number }) => ({
      source: r.source,
      chunks: Number(r.chunks),
    }));
  } catch (err) {
    console.error('[ops/rag] chunk_counts RPC failed:', err);
    return null;
  }
}

export async function handleRag(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const { windowDays, includeEvals } = windowParams(req);
  const redis = redisFromEnv(res, 'ops/rag');
  if (!redis) return;
  const r = redis as unknown as OpsStatsRedis;

  const cacheKey = `ops:rag:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await cacheAside<RagStatsData>(
      r,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const now = new Date();
        const [{ traces, observations }, indexCounts] = await Promise.all([
          getWindowRaw(r, windowDays, now),
          fetchIndexCounts(),
        ]);
        const scoped = realUser(applyEvalScope(traces, includeEvals));
        return {
          ...ragStats(scoped, observations),
          index_counts: indexCounts,
        };
      },
      { scheduleRefresh: waitUntil },
    );
    sendCached(res, data, cached, stale);
  } catch (err) {
    console.error('[ops/rag] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}

export async function handleDefense(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const { windowDays, includeEvals } = windowParams(req);
  const redis = redisFromEnv(res, 'ops/defense');
  if (!redis) return;
  const r = redis as unknown as OpsStatsRedis;

  const cacheKey = `ops:defense:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await cacheAside<DefenseData>(
      r,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const { traces } = await getWindowRaw(r, windowDays);
        return defenseStats(applyEvalScope(traces, includeEvals));
      },
      { scheduleRefresh: waitUntil },
    );
    sendCached(res, data, cached, stale);
  } catch (err) {
    console.error('[ops/defense] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}

function evalsResultsDir(): string {
  return resolve(process.cwd(), 'evals', 'results');
}

async function readBaselineSha(): Promise<string | null> {
  const raw = await readFile(
    resolve(evalsResultsDir(), 'baseline.json'),
    'utf-8',
  ).catch(() => null);
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as BaselinePointer).baseline_commit_sha ?? null;
  } catch {
    return null;
  }
}

async function readAllResults(): Promise<EvalResult[]> {
  const dir = resolve(evalsResultsDir(), 'by-commit');
  const files = await readdir(dir).catch(() => [] as string[]);
  const jsons = files.filter((f) => f.endsWith('.json'));
  const out: EvalResult[] = [];
  for (const f of jsons) {
    const raw = await readFile(resolve(dir, f), 'utf-8').catch(() => null);
    if (raw === null) continue;
    try {
      out.push(JSON.parse(raw) as EvalResult);
    } catch {
      // skip an unparseable result file rather than 500 the whole tab.
    }
  }
  return out;
}

export async function handleEvals(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const redis = redisFromEnv(res, 'ops/evals');
  if (!redis) return;
  const r = redis as unknown as OpsStatsRedis;

  try {
    const { data, cached, stale } = await cacheAside<EvalsData>(
      r,
      'ops:evals',
      EVALS_CACHE_TTL_SECONDS,
      async () => {
        const [results, baselineSha] = await Promise.all([
          readAllResults(),
          readBaselineSha(),
        ]);
        return assembleEvals(results, baselineSha);
      },
      { scheduleRefresh: waitUntil },
    );
    sendCached(res, data, cached, stale);
  } catch (err) {
    console.error('[ops/evals] assembly failed:', err);
    res.status(502).json({ error: 'assembly failed' });
  }
}

// Best-effort Langfuse prompt labels/updatedAt. Returns nulls on any error
// or unexpected shape — the prompt panel still renders from local constants.
async function fetchPromptMeta(): Promise<
  Pick<PromptInfo, 'labels' | 'updated_at'>
> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const base = process.env.LANGFUSE_BASE_URL ?? LANGFUSE_DEFAULT_BASE;
  if (!publicKey || !secretKey) return { labels: null, updated_at: null };
  try {
    const res = await fetch(
      `${base.replace(/\/+$/, '')}/api/public/v2/prompts/${encodeURIComponent(PROMPT_NAME)}`,
      {
        headers: {
          Authorization: 'Basic ' + btoa(`${publicKey}:${secretKey}`),
        },
      },
    );
    if (!res.ok) return { labels: null, updated_at: null };
    const p = (await res.json()) as Record<string, unknown>;
    return {
      labels: Array.isArray(p.labels) ? (p.labels as string[]) : null,
      updated_at:
        typeof p.updatedAt === 'string'
          ? p.updatedAt
          : typeof p.createdAt === 'string'
            ? p.createdAt
            : null,
    };
  } catch {
    return { labels: null, updated_at: null };
  }
}

async function rateLimitCounts(
  redis: Redis,
): Promise<{ counts: number[]; window: string }> {
  const window = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const keys = await redis.keys(`rl:chat:*:${window}`);
  if (keys.length === 0) return { counts: [], window };
  const vals = await redis.mget<(number | string | null)[]>(...keys);
  const counts = vals.map((v) => Number(v) || 0);
  return { counts, window };
}

const PROVIDERS = [
  { name: 'Langfuse', region: 'Tokyo (jp)', plan: 'Hobby' },
  { name: 'Upstash Redis', region: 'Mumbai', plan: 'Free' },
  { name: 'Supabase', region: 'pgvector', plan: 'Free' },
  { name: 'Resend', region: 'Tokyo', plan: 'Free' },
  { name: 'Vercel', region: 'edge', plan: 'Hobby' },
];

export async function handleSystem(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const redis = redisFromEnv(res, 'ops/system');
  if (!redis) return;

  try {
    const { data, cached, stale } = await cacheAside<SystemData>(
      redis as unknown as OpsStatsRedis,
      'ops:system',
      CACHE_TTL_SECONDS,
      async () => {
        const [promptMeta, rl, observations] = await Promise.all([
          fetchPromptMeta(),
          rateLimitCounts(redis),
          opsObservations({ windowDays: 30 }).catch(() => []),
        ]);
        const prompt: PromptInfo = {
          name: PROMPT_NAME,
          version: PROMPT_VERSION_NUMBER,
          hash: PROMPT_VERSION,
          canary_prefix: `${CANARY_TOKEN.slice(0, 9)}…`,
          labels: promptMeta.labels,
          updated_at: promptMeta.updated_at,
        };
        return {
          prompt,
          rate_limits: summarizeRateLimits(
            rl.counts,
            RATE_LIMIT_PER_IP,
            rl.window,
          ),
          headroom: [
            headroomBar(
              'langfuse_obs',
              'Langfuse observations (30d)',
              observations.length,
              LANGFUSE_OBS_MONTHLY_CAP,
              '50k / mo · Hobby',
            ),
          ],
          providers: PROVIDERS,
        };
      },
      { scheduleRefresh: waitUntil },
    );
    sendCached(res, data, cached, stale);
  } catch (err) {
    console.error('[ops/system] assembly failed:', err);
    res.status(502).json({ error: 'assembly failed' });
  }
}

export async function handleTraceDetail(
  _req: VercelRequest,
  res: VercelResponse,
  id: string,
): Promise<void> {
  if (!id) {
    res.status(400).json({ error: 'missing trace id' });
    return;
  }
  const host = process.env.LANGFUSE_BASE_URL ?? LANGFUSE_DEFAULT_BASE;
  try {
    const { trace, observations, scores } = await opsTraceById(id);
    if (!trace) {
      res.status(404).json({ error: 'trace not found' });
      return;
    }
    res
      .setHeader('cache-control', 'no-store')
      .status(200)
      .json(buildDetail(trace, observations, scores, host));
  } catch (err) {
    console.error('[ops/trace] detail failed:', err);
    res.status(502).json({ error: 'detail failed' });
  }
}
