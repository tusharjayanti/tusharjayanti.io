// POST /api/ops/login — single-user password login for the private /ops
// dashboard. On a correct password it sets the signed ops_session cookie;
// failures return 401. Per-IP throttled (5/min) to blunt brute force.
//
// Node serverless runtime (node:crypto in _opsAuth, Upstash in _kv).

import type { VercelRequest, VercelResponse } from '../_types.js';
import { parseBody } from '../_compat.js';
import { hashIp, checkOpsLoginRateLimit } from '../_kv.js';
import { verifyOpsPassword, issueSession, issueCookie } from '../_opsAuth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  // Fail-closed if the operator hasn't configured the secrets — never
  // hand out a session signed with an absent key.
  if (!process.env.OPS_PASSWORD || !process.env.OPS_SESSION_SECRET) {
    res.status(503).json({ error: 'ops auth not configured' });
    return;
  }

  // Per-IP throttle. A Redis hiccup fails open (TLS + password still
  // gate the request); the throttle is brute-force friction, not the
  // primary control.
  let ipHash = 'unknown';
  try {
    ipHash = await hashIp(req);
    const rl = await checkOpsLoginRateLimit(ipHash);
    if (!rl.ok) {
      res.status(429).json({ error: 'too many attempts, slow down' });
      return;
    }
  } catch (err) {
    console.error('[ops/login] rate-limit check failed:', err);
  }

  const body = (await parseBody(req)) as { password?: unknown } | null;
  if (!verifyOpsPassword(body?.password)) {
    res.status(401).json({ error: 'invalid password' });
    return;
  }

  res.setHeader('Set-Cookie', issueCookie(issueSession()));
  res.status(200).json({ ok: true });
}
