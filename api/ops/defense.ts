// GET /api/ops/defense?windowDays=&includeEvals= — Defense tab rollup.
// Guarded. Guardrail funnel + per-tag counts + recent security events.
// Applies the eval scope but NOT realUser — the rate-limited /
// injection-detected short-circuits realUser drops are exactly what this
// tab visualizes. Cache-aside under ops:defense:{windowDays}:{includeEvals}.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { getWindowRaw, applyEvalScope } from '../_opsQuery.js';
import { defenseStats, type DefenseData } from '../_opsDefense.js';
import { cacheAside, type OpsStatsRedis } from '../_opsStats.js';

export const config = { runtime: 'nodejs' };

const ALLOWED_WINDOWS = new Set([1, 7, 30]);
const CACHE_TTL_SECONDS = 5 * 60;

function parseParams(req: VercelRequest) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wRaw = Number.parseInt(url.searchParams.get('windowDays') ?? '', 10);
  const windowDays = ALLOWED_WINDOWS.has(wRaw) ? wRaw : 7;
  const ie = url.searchParams.get('includeEvals');
  return { windowDays, includeEvals: ie === 'true' || ie === '1' };
}

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

  const { windowDays, includeEvals } = parseParams(req);

  let redis: OpsStatsRedis;
  try {
    redis = Redis.fromEnv() as unknown as OpsStatsRedis;
  } catch (err) {
    console.error('[ops/defense] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

  const cacheKey = `ops:defense:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await cacheAside<DefenseData>(
      redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const { traces } = await getWindowRaw(redis, windowDays);
        return defenseStats(applyEvalScope(traces, includeEvals));
      },
      { scheduleRefresh: waitUntil },
    );
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(data);
  } catch (err) {
    console.error('[ops/defense] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}
