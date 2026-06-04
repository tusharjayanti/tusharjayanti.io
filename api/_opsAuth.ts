// Single-user signed-session auth for the private /ops dashboard.
//
// The session cookie is a stateless HMAC token: `${payloadB64url}.${sigB64url}`
// where payload = { exp } (expiry, epoch SECONDS) and sig =
// HMAC-SHA256(payloadB64url, OPS_SESSION_SECRET). There is no server-side
// session store — verification recomputes the HMAC and constant-time-compares.
// Expiry is carried INSIDE the signed payload, so a client cannot extend its
// own session without the secret.
//
// Node serverless runtime only (uses node:crypto). Reuses the audited
// constant-time comparator from _authBearer.ts rather than hand-rolling a new
// `===` (the same primitive the cron / webhook / ops-snippet auth paths use).

import { createHmac } from 'node:crypto';
import { constantTimeStringEqual } from './_authBearer.js';
import { getHeader } from './_compat.js';

export const OPS_COOKIE_NAME = 'ops_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // ~7 days

export interface SessionPayload {
  exp: number; // expiry, epoch SECONDS
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function sessionSecret(): string {
  const secret = process.env.OPS_SESSION_SECRET;
  if (!secret) throw new Error('OPS_SESSION_SECRET not configured');
  return secret;
}

// Sign a session token. `exp` is epoch seconds; prefer issueSession() which
// computes exp = now + SESSION_TTL_SECONDS.
export function signSession(payload: SessionPayload): string {
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, sessionSecret())}`;
}

// Verify a token: recompute the HMAC, constant-time compare, then check
// expiry. Returns the payload on success, null on ANY failure (missing,
// malformed, tampered signature, expired, or secret unset). `nowSeconds`
// is injectable for deterministic tests.
export function verifySession(
  token: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64, sessionSecret());
  } catch {
    return null; // secret not configured — treat as unauthenticated
  }
  if (!constantTimeStringEqual(sig, expectedSig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8'),
    ) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || payload.exp <= nowSeconds)
    return null;
  return { exp: payload.exp };
}

// Constant-time password check against OPS_PASSWORD. Fail-closed: returns
// false when the env var is unset or the input isn't a string.
export function verifyOpsPassword(input: unknown): boolean {
  const expected = process.env.OPS_PASSWORD;
  if (!expected || typeof input !== 'string') return false;
  return constantTimeStringEqual(input, expected);
}

// Build a signed token valid for SESSION_TTL_SECONDS from `nowSeconds`.
export function issueSession(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return signSession({ exp: nowSeconds + SESSION_TTL_SECONDS });
}

// Set-Cookie value for an issued session. httpOnly (no JS access), Secure
// (HTTPS only), SameSite=Strict (never sent cross-site), Path=/, Max-Age
// aligned to the token TTL.
export function issueCookie(token: string): string {
  return [
    `${OPS_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

// Set-Cookie value that immediately expires the session (logout).
export function clearCookie(): string {
  return [
    `${OPS_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

// Extract the ops_session token from a request's Cookie header. Returns
// undefined when absent. Works across the Web Request / Node IncomingMessage
// header shapes via the shared getHeader adapter.
export function readSessionCookie(req: unknown): string | undefined {
  const raw = getHeader(req, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === OPS_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

// Guard for data endpoints: read the cookie + verify in one call. Returns
// the session payload (truthy) or null. Every /api/ops/* data endpoint
// short-circuits to 401 when this returns null.
export function requireSession(
  req: unknown,
  nowSeconds?: number,
): SessionPayload | null {
  return verifySession(readSessionCookie(req), nowSeconds);
}
