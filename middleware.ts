// Vercel Edge Middleware — M2.8 visitor counter.
// Runs on `/` and `/terminal`; increments a per-day Redis hash with
// the visitor's hashed IP. Hashing + counter logic lives in
// `api/_visitorCounter.ts` so it's unit-testable without a real
// edge runtime. This file is the thin wrapper.
//
// Latency contract: middleware never blocks the response. The
// Redis HSET runs inside `@vercel/functions` waitUntil so the page
// continues rendering immediately.

import { waitUntil } from '@vercel/functions';
import { Redis } from '@upstash/redis';
import {
  extractIp,
  hashIpForVisitor,
  isBotUserAgent,
  recordVisitor,
} from './api/_visitorCounter.js';

export const config = {
  // Only the page routes the spec calls out. /cv and direct-link
  // entries to non-matched routes don't count today; revisit if/when
  // the v0.3.0 widget moves to the cv view too.
  matcher: ['/', '/terminal', '/cv'],
};

export default async function middleware(req: Request): Promise<Response | undefined> {
  // Skip bots — kills the obvious crawler noise so the visitor count
  // reflects real traffic. Imperfect (no IP reverse-lookup, no
  // behavioral fingerprinting); we accept the residual noise.
  const ua = req.headers.get('user-agent');
  if (isBotUserAgent(ua)) {
    return undefined;
  }

  const ip = extractIp(req.headers);
  if (!ip) {
    // Unknown IP (very rare on Vercel). Skip the counter rather than
    // double-incrementing a placeholder field.
    return undefined;
  }

  // waitUntil registers the increment without blocking the response.
  // Errors are caught + logged but never surface to the user — a
  // visitor-counter failure is not page-render-fatal.
  waitUntil(
    (async () => {
      try {
        const ipHash = await hashIpForVisitor(ip);
        const redis = Redis.fromEnv();
        await recordVisitor(redis, ipHash);
      } catch (err) {
        console.error('[ops/visitor] increment failed:', err);
      }
    })(),
  );

  return undefined;
}
