// Constant-time Bearer-secret comparison helper. Runtime-agnostic —
// no node:crypto, no Buffer — so the same helper can be imported by
// Vercel Edge handlers (api/cron/digest.ts) AND Node-runtime handlers
// (api/ops-snippet.ts). The pure-JS XOR-accumulate compare is sync,
// matches the security audit's recommendation, and runs identically on
// every JavaScript runtime.
//
// Note vs the github-webhook's verifySignature: the webhook performs
// real HMAC signature verification over the request body (the secret
// never travels on the wire). The cron + ops-snippet endpoints receive
// a literal `Bearer <secret>` header — no payload signature — so the
// helper here is just a constant-time string compare. The constant-
// time property defeats locally-introspected timing oracles; the
// security model otherwise relies on TLS + secret rotation, not on
// the comparison algorithm.

/**
 * Constant-time string equality. Length-mismatch returns false early
 * — the expected token length is operator-public (== 7 + secret.length,
 * fixed at deploy), so the length-leak conveys no useful information
 * to a remote attacker. The byte loop runs to completion for the
 * equal-length case, so character-position timing reveals nothing.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

/**
 * Constant-time comparison of an inbound Authorization header against
 * the expected `Bearer <secret>` form. Non-string headers (Node's
 * per-spec `string | string[] | undefined` shape) return false uniformly.
 */
export function timingSafeBearerMatch(
  authHeader: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof authHeader !== 'string') return false;
  return constantTimeStringEqual(authHeader, `Bearer ${secret}`);
}

/**
 * Cron-style auth check that distinguishes "secret not configured"
 * (operator deployment-misconfiguration; respond 503 fail-CLOSED) from
 * "auth header rejected" (respond 401). The single-boolean shape
 * `timingSafeBearerMatch` returns conflates both — callers that need
 * the distinction use this richer result.
 */
export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: 'not-configured' }
  | { ok: false; reason: 'invalid' };

export function verifyCronAuth(
  authHeader: string | string[] | undefined,
  envSecret: string | undefined,
): CronAuthResult {
  if (!envSecret) {
    return { ok: false, reason: 'not-configured' };
  }
  if (timingSafeBearerMatch(authHeader, envSecret)) {
    return { ok: true };
  }
  return { ok: false, reason: 'invalid' };
}
