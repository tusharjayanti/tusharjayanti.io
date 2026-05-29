// Pure logic for the visitor counter. Kept separate from the
// Vercel middleware wrapper at the repo root so it can be unit-tested
// against fakes (no edge runtime, no live Redis).
//
// Counts unique visitors per UTC day via a Redis hash keyed
// `ops:visitors:YYYY-MM-DD` whose fields are SHA-256 truncated
// IP-hashes (16 hex chars). Repeated visits from the same IP-hash
// hit the same field, so HLEN naturally dedupes within a day. The
// 7-day visitor count (surfaced in the ops snippet) sums HLEN across
// the last 7 day-keyed hashes.
//
// Bot filter is a regex on the User-Agent. Imperfect but kills the
// obvious noise — googlebot, slackbot, link-preview crawlers etc.
// IPs are never stored raw; we only ever persist the hash.

// Bot + curl-class UAs. The bot half (bot/crawler/spider/etc) catches
// indexers + link-preview fetchers; the curl half (curl/wget/
// node-fetch/python-requests/http-client) catches verification
// traffic — smoke scripts, CI probes, ad-hoc curl debugging. Both
// classes never count toward "real visitors."
const BOT_UA =
  /bot|crawler|spider|crawling|preview|googlebot|bingbot|slackbot|discordbot|curl|wget|node-fetch|python-requests|http-client/i;
const HASH_PREFIX_LEN = 16;
const VISITOR_HASH_TTL_SECONDS = 60 * 60 * 24 * 8; // 8 days

export interface VisitorRedis {
  hset(key: string, field: Record<string, string | number>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return BOT_UA.test(userAgent);
}

// SHA-256 of the raw IP, truncated to 16 hex chars. Edge-runtime safe
// (uses crypto.subtle, no Buffer). 16 chars = 64 bits of entropy,
// plenty for per-day uniqueness in a portfolio-traffic regime; short
// enough to keep Redis hash field strings compact.
export async function hashIpForVisitor(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_PREFIX_LEN);
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function visitorHashKey(day: string): string {
  return `ops:visitors:${day}`;
}

export async function recordVisitor(
  redis: VisitorRedis,
  ipHash: string,
  day: string = todayUtc(),
): Promise<void> {
  const key = visitorHashKey(day);
  await redis.hset(key, { [ipHash]: 1 });
  // EXPIRE is unconditional — Upstash treats setting the same TTL on
  // an existing key as a no-op, so this is safe to fire on every
  // visit. Bounds the key at 8 days even if HSET no-ops on repeat
  // visitors.
  await redis.expire(key, VISITOR_HASH_TTL_SECONDS);
}

// Resolve the calling client's IP from request headers with an
// un-spoofable preference order:
//
//   1. x-real-ip                       — Vercel sets this from the
//                                        connecting socket; not
//                                        client-spoofable.
//   2. last entry of x-forwarded-for   — Vercel APPENDS the real IP to
//   3. last entry of x-vercel-forwarded-for  whatever the client sent,
//                                        so the trailing entry is closest
//                                        to Vercel's edge. The leftmost
//                                        entry is attacker-controlled (a
//                                        client can prepend any IPs before
//                                        Vercel appends), so it's never
//                                        trustworthy. Reading [0] is the
//                                        canonical rate-limit-bypass bug.
//   4. null fallback
//
// DO NOT "simplify" this by reading the leftmost entry — that re-introduces
// the rate-limit / visitor-counter spoofing fixed in fix/security-hardening.
// Shared by api/_kv.ts via this module so the rate-limiter and visitor
// counter key off identical IPs for the same request.
export function pickClientIp(
  lookup: (name: string) => string | null | undefined,
): string | null {
  const real = lookup('x-real-ip');
  if (real) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }
  const xffLast = lastNonEmptyEntry(lookup('x-forwarded-for'));
  if (xffLast) return xffLast;
  const xvffLast = lastNonEmptyEntry(lookup('x-vercel-forwarded-for'));
  if (xvffLast) return xvffLast;
  return null;
}

function lastNonEmptyEntry(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  const parts = headerValue
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

// Thin Headers adapter for middleware callers (Web Headers API). The
// lookup-function argument is what makes pickClientIp portable to api/_kv.ts
// (which goes through _compat.getHeader instead).
export function extractIp(headers: Headers): string | null {
  return pickClientIp((name) => headers.get(name));
}
