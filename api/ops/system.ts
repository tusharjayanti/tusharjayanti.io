// GET /api/ops/system — System tab. Guarded. Current registered prompt
// version (local constants + best-effort Langfuse labels), this-hour chat
// rate-limit counters (Upstash), free-tier headroom (Langfuse observations
// vs the Hobby monthly cap), and provider/region facts. Cache-aside ~5 min.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { opsObservations } from '../_opsQuery.js';
import { cacheAside, type OpsStatsRedis } from '../_opsStats.js';
import {
  headroomBar,
  summarizeRateLimits,
  type PromptInfo,
  type SystemData,
} from '../_opsSystem.js';
import {
  PROMPT_NAME,
  PROMPT_VERSION,
  PROMPT_VERSION_NUMBER,
  CANARY_TOKEN,
} from '../_systemPrompt.js';

export const config = { runtime: 'nodejs' };

const CACHE_TTL_SECONDS = 5 * 60;
const RATE_LIMIT_PER_IP = 40; // matches _kv.ts checkRateLimit
const LANGFUSE_OBS_MONTHLY_CAP = 50_000; // Hobby tier observation budget

// Best-effort Langfuse prompt labels/updatedAt. Returns nulls on any error
// or unexpected shape — the prompt panel still renders from local constants.
async function fetchPromptMeta(): Promise<
  Pick<PromptInfo, 'labels' | 'updated_at'>
> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const base = process.env.LANGFUSE_BASE_URL ?? 'https://jp.cloud.langfuse.com';
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

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('method not allowed');
    return;
  }
  if (!requireSession(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let redis: Redis;
  try {
    redis = Redis.fromEnv();
  } catch (err) {
    console.error('[ops/system] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

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
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(data);
  } catch (err) {
    console.error('[ops/system] assembly failed:', err);
    res.status(502).json({ error: 'assembly failed' });
  }
}
