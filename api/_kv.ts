import { Redis } from '@upstash/redis';
import { getHeader } from './_compat.js';
import { pickClientIp } from './_visitorCounter.js';

const redis = Redis.fromEnv();

const RATE_MAX = 40;
const RATE_WINDOW_SECONDS = 60 * 60 * 2; // 2h TTL — garbage-collects old hour-buckets
const LOG_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const Q_MAX_LOG_CHARS = 500;
const A_PREVIEW_MAX_CHARS = 280;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function hashIp(req: unknown): Promise<string> {
  // Shared header-precedence with extractIp in _visitorCounter so the
  // rate-limiter and visitor-counter resolve to identical IPs for the
  // same request. See pickClientIp for the un-spoofable lookup order.
  const ip = pickClientIp((name) => getHeader(req, name) ?? null) ?? 'unknown';
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkRateLimit(
  ipHash: string,
): Promise<{ ok: boolean; count: number }> {
  const hour = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const key = `rl:chat:${ipHash}:${hour}`;
  const count = await redis.incr(key);
  await redis.expire(key, RATE_WINDOW_SECONDS);
  return { ok: count <= RATE_MAX, count };
}

// Ops dashboard login throttle: 5 attempts per minute per IP. Separate
// key namespace + minute-bucket from the chat rate-limiter; the window
// lives in the key's minute stamp, the 2-minute TTL just garbage-collects
// the bucket (same pattern as checkRateLimit's hour bucket).
const OPS_LOGIN_MAX = 5;
export async function checkOpsLoginRateLimit(
  ipHash: string,
): Promise<{ ok: boolean; count: number }> {
  const minute = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  const key = `rl:ops-login:${ipHash}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 120);
  }
  return { ok: count <= OPS_LOGIN_MAX, count };
}

export type LogTurnArgs = {
  ipHash: string;
  q: string;
  aPreview: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model?: string;
  latencyMs?: number;
  canary_leak?: boolean;
};

export async function logChatTurn(args: LogTurnArgs): Promise<void> {
  const key = `chat:log:${todayUtc()}`;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    ip_hash: args.ipHash,
    q: args.q.slice(0, Q_MAX_LOG_CHARS),
    a_preview: args.aPreview.slice(0, A_PREVIEW_MAX_CHARS),
    ...(args.tokensIn !== undefined && { tokens_in: args.tokensIn }),
    ...(args.tokensOut !== undefined && { tokens_out: args.tokensOut }),
    ...(args.cacheCreationTokens !== undefined && {
      cache_creation_tokens: args.cacheCreationTokens,
    }),
    ...(args.cacheReadTokens !== undefined && {
      cache_read_tokens: args.cacheReadTokens,
    }),
    ...(args.model !== undefined && { model: args.model }),
    ...(args.latencyMs !== undefined && { latency_ms: args.latencyMs }),
    ...(args.canary_leak !== undefined && { canary_leak: args.canary_leak }),
  });
  const newLength = await redis.lpush(key, payload);
  if (newLength === 1) {
    await redis.expire(key, LOG_TTL_SECONDS);
  }
}

// Error log: separate key namespace, 30-day TTL (errors are rarer and more
// important to retain than routine chat turns).
const ERROR_LOG_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const ERROR_Q_MAX_CHARS = 200;
const ERROR_DETAIL_MAX_CHARS = 500;

export type LogErrorArgs = {
  ipHash: string;
  q: string;
  category: 'validation' | 'rate-limit' | 'server' | 'anthropic';
  detail: string;
};

export async function logChatError(args: LogErrorArgs): Promise<void> {
  const key = `chat:errors:${todayUtc()}`;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    ip_hash: args.ipHash,
    q: args.q.slice(0, ERROR_Q_MAX_CHARS),
    category: args.category,
    detail: args.detail.slice(0, ERROR_DETAIL_MAX_CHARS),
  });
  const newLength = await redis.lpush(key, payload);
  if (newLength === 1) {
    await redis.expire(key, ERROR_LOG_TTL_SECONDS);
  }
}

// Canary leak events: each detection LPUSHes a LeakEvent to the `leak:events`
// list. The list holds both active (canary === current) and stale entries;
// stale entries are filtered at read time and lazily LREMed by the cron.
export type LeakEvent = {
  ts: number;
  canary: string;
  ipHash: string;
  userAgent: string;
  geoCountry: string | null;
  lastAlertedAt: number;
};

export async function recordLeakEvent(
  event: Pick<LeakEvent, 'canary' | 'ipHash' | 'userAgent' | 'geoCountry'>,
): Promise<LeakEvent> {
  const ts = Date.now();
  const payload: LeakEvent = { ...event, ts, lastAlertedAt: ts };
  await redis.lpush('leak:events', JSON.stringify(payload));
  return payload;
}

export async function getActiveLeaks(
  currentCanary: string,
): Promise<LeakEvent[]> {
  const entries = (await redis.lrange('leak:events', 0, -1)) as unknown[];
  return entries
    .map((raw) => {
      try {
        return typeof raw === 'string'
          ? (JSON.parse(raw) as LeakEvent)
          : (raw as LeakEvent);
      } catch {
        return null;
      }
    })
    .filter((e): e is LeakEvent => e !== null && e.canary === currentCanary);
}

// LREM the original entry + LPUSH a copy with lastAlertedAt set to the new
// value. Redis lists don't support in-place updates so this two-step is the
// canonical pattern. Match-by-JSON relies on consistent key order at write
// time, which V8 preserves for object literals.
export async function updateLeakLastAlertedAt(
  entry: LeakEvent,
  lastAlertedAt: number,
): Promise<void> {
  await redis.lrem('leak:events', 1, JSON.stringify(entry));
  await redis.lpush('leak:events', JSON.stringify({ ...entry, lastAlertedAt }));
}

// Hourly error counter — incremented on every chat error so spike detection
// can compare against a threshold. Key TTL is 2h so the previous hour's count
// briefly overlaps but doesn't bleed into the next hour's bucket.
export async function getHourlyErrorCount(): Promise<number> {
  const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const key = `chat:errors:hourly:${hourKey}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60 * 60 * 2);
  }
  return count;
}

// Atomic test-and-set on the alert-sent flag for the current hour. Returns
// true only on the caller that successfully claims the slot — NX makes this
// safe across concurrent error logs in the same hour.
export async function shouldSendSpikeAlert(): Promise<boolean> {
  const hourKey = new Date().toISOString().slice(0, 13);
  const alertKey = `chat:errors:alert-sent:${hourKey}`;
  const wasSet = await redis.set(alertKey, '1', {
    ex: 60 * 60 * 2,
    nx: true,
  });
  return wasSet === 'OK';
}
