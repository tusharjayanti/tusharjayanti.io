// GET /api/ops-snippet — returns the aggregated metrics blob the
// terminal page's ops widget renders. Edge runtime, no caching at
// the CDN layer (we cache server-side in Redis with our own TTL +
// lock so multiple concurrent visitors don't all trigger Langfuse
// API calls).
//
// Failure mode is "always return JSON, never 5xx": every error
// downgrades to the offline sentinel so the widget can render its
// `offline` state without a fetch failure.

import { Redis } from '@upstash/redis';
import {
  OFFLINE_SNIPPET,
  getOpsSnippet,
  type SnippetRedis,
} from './_opsSnippet.js';
import {
  ZERO_LANGFUSE_AGGREGATE,
  makeLangfuseAggregate,
} from './_langfuseQuery.js';

export const runtime = 'edge';

function ttlFromEnv(): number {
  const raw = process.env.OPS_SNIPPET_CACHE_TTL_SECONDS;
  if (!raw) return 600; // 10 minutes default
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 600;
  return parsed;
}

export default async function handler(): Promise<Response> {
  let redis: SnippetRedis;
  try {
    redis = Redis.fromEnv() as unknown as SnippetRedis;
  } catch (err) {
    console.error('[ops/snippet] Redis init failed:', err);
    return jsonResponse(OFFLINE_SNIPPET);
  }

  const lf = makeLangfuseAggregate() ?? ZERO_LANGFUSE_AGGREGATE;
  try {
    const snippet = await getOpsSnippet(redis, lf, {
      cacheTtlSeconds: ttlFromEnv(),
    });
    return jsonResponse(snippet);
  } catch (err) {
    console.error('[ops/snippet] unexpected failure:', err);
    return jsonResponse(OFFLINE_SNIPPET);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // No CDN caching; the source of truth is the Redis blob with
      // its own 5-minute freshness window.
      'cache-control': 'no-store',
    },
  });
}
