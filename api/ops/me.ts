// GET /api/ops/me — session probe. 200 + { authenticated:true, exp } when the
// ops_session cookie verifies, else 401. The dashboard hits this on mount to
// decide between rendering the password gate and the dashboard.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { requireSession } from '../_opsAuth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('method not allowed');
    return;
  }
  const session = requireSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.status(200).json({ authenticated: true, exp: session.exp });
}
