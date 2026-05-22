// Pure logic for the M2.8 visitor counter. Kept separate from the
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

const BOT_UA =
  /bot|crawler|spider|crawling|preview|googlebot|bingbot|slackbot|discordbot/i;
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

// Extracts the first IP from x-forwarded-for or falls back to
// x-real-ip / x-vercel-forwarded-for. Returns null if none are
// present (rare; usually means a direct internal request).
export function extractIp(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = headers.get('x-real-ip');
  if (xri) return xri.trim();
  const xvff = headers.get('x-vercel-forwarded-for');
  if (xvff) {
    const first = xvff.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}
