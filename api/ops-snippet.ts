// GET /api/ops-snippet — returns the aggregated metrics blob the
// terminal page's ops widget renders. Node serverless runtime;
// we cache server-side in Redis with our own TTL + lock so
// concurrent visitors don't all trigger Langfuse API calls. No CDN
// caching layered on top.
//
// Failure mode is "always return JSON, never 5xx": every error
// downgrades to the offline sentinel so the widget can render its
// `offline` state without a fetch failure.
//
// Handler signature is the canonical Vercel Node shape —
// `(req: VercelRequest, res: VercelResponse) => Promise<void>`.
// Returning a `Response` is the edge-runtime pattern; under Node
// serverless that return value is silently discarded and the
// function hangs until the 300s timeout. Caught in preview after
// the M2.8 ship.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';
import {
  LOCK_KEY,
  OFFLINE_SNIPPET,
  SNIPPET_KEY,
  getOpsSnippet,
  type SnippetRedis,
} from './_opsSnippet.js';
import {
  ZERO_LANGFUSE_AGGREGATE,
  makeLangfuseAggregate,
} from './_langfuseQuery.js';

export const config = { runtime: 'nodejs' };

function ttlFromEnv(): number {
  const raw = process.env.OPS_SNIPPET_CACHE_TTL_SECONDS;
  if (!raw) return 600; // 10 minutes default
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 600;
  return parsed;
}

function sendJson(res: VercelResponse, body: unknown): void {
  res
    // No CDN caching; the source of truth is the Redis blob with
    // its own 5-minute freshness window.
    .setHeader('cache-control', 'no-store')
    .status(200)
    .json(body);
}

// Admin endpoint: drop the cached snippet (and any stale rebuild
// lock) so the next GET triggers a fresh aggregation. Used by the
// on-demand lock-contention test in `scripts/test/lock-contention.ts`.
// Gated on `Authorization: Bearer ${CRON_SECRET}` — same shape as
// the existing cron route, so we don't introduce a new secret. Not
// part of the regular operator surface; documented in docs/rag.md.
async function handleDelete(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).send('CRON_SECRET not configured');
    return;
  }
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${expected}`) {
    res.status(401).send('unauthorized');
    return;
  }

  let redis: SnippetRedis;
  try {
    redis = Redis.fromEnv() as unknown as SnippetRedis;
  } catch (err) {
    console.error('[ops/snippet] Redis init failed (DELETE):', err);
    res.status(503).send('redis init failed');
    return;
  }

  try {
    await Promise.all([redis.del(SNIPPET_KEY), redis.del(LOCK_KEY)]);
  } catch (err) {
    console.error('[ops/snippet] cache DEL failed:', err);
    res.status(500).send('cache DEL failed');
    return;
  }
  res.status(204).end();
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method === 'DELETE') {
    await handleDelete(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('method not allowed');
    return;
  }

  let redis: SnippetRedis;
  try {
    redis = Redis.fromEnv() as unknown as SnippetRedis;
  } catch (err) {
    console.error('[ops/snippet] Redis init failed:', err);
    sendJson(res, OFFLINE_SNIPPET);
    return;
  }

  const lf = makeLangfuseAggregate() ?? ZERO_LANGFUSE_AGGREGATE;
  try {
    const snippet = await getOpsSnippet(redis, lf, {
      cacheTtlSeconds: ttlFromEnv(),
    });
    sendJson(res, snippet);
  } catch (err) {
    console.error('[ops/snippet] unexpected failure:', err);
    sendJson(res, OFFLINE_SNIPPET);
  }
}
