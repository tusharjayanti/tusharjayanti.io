import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const RATE_WINDOW_SECONDS = 60 * 60; // 1 hour
const RATE_MAX = 15;
const LOG_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const Q_MAX_LOG_CHARS = 500;
const A_PREVIEW_MAX_CHARS = 280;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Web `Request.headers` has `.get(name)`; Node IncomingMessage (vercel dev)
// exposes `.headers` as a plain object with lowercase keys. Accept both.
function getHeader(req: unknown, name: string): string | undefined {
  const headers = (req as { headers?: unknown }).headers;
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const nodeHeaders = headers as
    | Record<string, string | string[] | undefined>
    | undefined;
  const value = nodeHeaders?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export async function hashIp(req: unknown): Promise<string> {
  const fwd = getHeader(req, 'x-forwarded-for');
  const ip = fwd
    ? fwd.split(',')[0].trim()
    : (getHeader(req, 'x-real-ip') ?? 'unknown');
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkRateLimit(
  ipHash: string,
): Promise<{ ok: boolean; count: number }> {
  const key = `rl:chat:${ipHash}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RATE_WINDOW_SECONDS);
  }
  return { ok: count <= RATE_MAX, count };
}

export type LogTurnArgs = {
  ipHash: string;
  q: string;
  aPreview: string;
};

export async function logChatTurn(args: LogTurnArgs): Promise<void> {
  const key = `chat:log:${todayUtc()}`;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    ip_hash: args.ipHash,
    q: args.q.slice(0, Q_MAX_LOG_CHARS),
    a_preview: args.aPreview.slice(0, A_PREVIEW_MAX_CHARS),
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
