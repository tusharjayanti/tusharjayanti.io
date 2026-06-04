// POST /api/ops/logout — clears the ops_session cookie. Stateless: there's
// no server-side session to revoke, so logout just overwrites the cookie
// with an immediately-expiring one. Idempotent; safe to call unauthenticated.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { clearCookie } from '../_opsAuth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  res.setHeader('Set-Cookie', clearCookie());
  res.status(200).json({ ok: true });
}
