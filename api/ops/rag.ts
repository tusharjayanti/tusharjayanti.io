// GET /api/ops/rag?windowDays=&includeEvals= — RAG tab rollup. Guarded.
// Retrieval outcomes + reranker stats over real-human traces, plus pgvector
// index counts from a Supabase count RPC (degrades to null if Supabase is
// paused/unreachable). Cache-aside under ops:rag:{windowDays}:{includeEvals}.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { getWindowRaw, applyEvalScope, realUser } from '../_opsQuery.js';
import { ragStats, type IndexCount, type RagStatsData } from '../_opsRag.js';
import { getSupabaseClient } from '../_supabase.js';
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
    console.error('[ops/rag] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

  const cacheKey = `ops:rag:${windowDays}:${includeEvals}`;
  try {
    const { data, cached, stale } = await cacheAside<RagStatsData>(
      redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const now = new Date();
        const [{ traces, observations }, indexCounts] = await Promise.all([
          getWindowRaw(redis, windowDays, now),
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
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(data);
  } catch (err) {
    console.error('[ops/rag] aggregation failed:', err);
    res.status(502).json({ error: 'aggregation failed' });
  }
}
