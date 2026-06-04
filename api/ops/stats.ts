// GET /api/ops/stats?windowDays=&includeEvals= — the Overview rollup.
// Guarded by the ops session. Reads through the canonical opsQuery +
// realUser scope, aggregates with aggregateStats, and caches the result
// in Upstash under ops:rollup:{windowDays}:{includeEvals} for ~5 minutes
// (cache-aside: miss → compute + set, hit → return).
//
// Node serverless runtime (Upstash + node:crypto via the session guard).

import type { VercelRequest, VercelResponse } from '../_types.js';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { getWindowRaw, applyEvalScope, realUser } from '../_opsQuery.js';
import {
  aggregateStats,
  getOpsStats,
  type OpsStatsRedis,
} from '../_opsStats.js';

export const config = { runtime: 'nodejs' };

const ALLOWED_WINDOWS = new Set([1, 7, 30]);
const CACHE_TTL_SECONDS = 5 * 60;

function parseParams(req: VercelRequest): {
  windowDays: number;
  includeEvals: boolean;
} {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wRaw = Number.parseInt(url.searchParams.get('windowDays') ?? '', 10);
  const windowDays = ALLOWED_WINDOWS.has(wRaw) ? wRaw : 7;
  const ie = url.searchParams.get('includeEvals');
  const includeEvals = ie === 'true' || ie === '1';
  return { windowDays, includeEvals };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('method not allowed');
    return;
  }
  // Auth guard — every /api/ops/* data endpoint short-circuits to 401.
  if (!requireSession(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { windowDays, includeEvals } = parseParams(req);

  let redis: OpsStatsRedis;
  try {
    redis = Redis.fromEnv() as unknown as OpsStatsRedis;
  } catch (err) {
    console.error('[ops/stats] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

  const cacheKey = `ops:rollup:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await getOpsStats(
      redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const now = new Date();
        const { traces, observations } = await getWindowRaw(
          redis,
          windowDays,
          now,
        );
        const kept = realUser(applyEvalScope(traces, includeEvals));
        return aggregateStats(kept, observations, {
          windowDays,
          includeEvals,
          now,
        });
      },
      { scheduleRefresh: waitUntil },
    );
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(data);
  } catch (err) {
    console.error('[ops/stats] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}
