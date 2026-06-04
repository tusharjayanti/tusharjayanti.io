// GET /api/ops/traces?windowDays=&includeEvals=&page=&limit= — paginated
// conversation list for the window. Guarded. Caches the full filtered,
// newest-first list under ops:conv:{windowDays}:{includeEvals} (~5 min),
// then slices the requested page in-memory — no per-page Langfuse round-trip.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { getWindowRaw, applyEvalScope, realUser } from '../_opsQuery.js';
import {
  toListItem,
  paginateList,
  type ConversationListItem,
} from '../_opsConversations.js';
import { cacheAside, type OpsStatsRedis } from '../_opsStats.js';

export const config = { runtime: 'nodejs' };

const ALLOWED_WINDOWS = new Set([1, 7, 30]);
const CACHE_TTL_SECONDS = 5 * 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseParams(req: VercelRequest) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wRaw = Number.parseInt(url.searchParams.get('windowDays') ?? '', 10);
  const windowDays = ALLOWED_WINDOWS.has(wRaw) ? wRaw : 7;
  const ie = url.searchParams.get('includeEvals');
  const includeEvals = ie === 'true' || ie === '1';
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1,
  );
  const limRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Math.min(MAX_LIMIT, limRaw > 0 ? limRaw : DEFAULT_LIMIT);
  return { windowDays, includeEvals, page, limit };
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

  const { windowDays, includeEvals, page, limit } = parseParams(req);

  let redis: OpsStatsRedis;
  try {
    redis = Redis.fromEnv() as unknown as OpsStatsRedis;
  } catch (err) {
    console.error('[ops/traces] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

  const cacheKey = `ops:conv:${windowDays}:${includeEvals}`;
  try {
    const {
      data: all,
      cached,
      stale,
    } = await cacheAside<{
      items: ConversationListItem[];
    }>(
      redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const { traces } = await getWindowRaw(redis, windowDays);
        const items = realUser(applyEvalScope(traces, includeEvals))
          .map(toListItem)
          .sort((a, b) => b.ts.localeCompare(a.ts)); // newest first
        return { items };
      },
      { scheduleRefresh: waitUntil },
    );
    const result = paginateList(all.items, page, limit);
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(result);
  } catch (err) {
    console.error('[ops/traces] list failed:', err);
    res.status(502).json({ error: 'list failed' });
  }
}
