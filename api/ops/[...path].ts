// Single Node serverless function fronting every /api/ops/* route. Vercel's
// Hobby plan caps a deployment at 12 serverless functions; collapsing the ten
// former api/ops/*.ts route files behind this one catch-all keeps the
// dashboard's API surface to ONE function while preserving all public URLs.
//
// Routes by path segments after /api/ops/ + HTTP method. requireSession guards
// the data routes HERE; login/logout/me carry their own auth behavior. The
// handler bodies live in api/_opsRouteHandlers.ts (the _ops*.ts business
// modules are unchanged). evals reads by-commit JSON via fs — fine, this
// function is Node (the includeFiles glob in vercel.json moves to this file).

import type { VercelRequest, VercelResponse } from '../_types.js';
import { requireSession } from '../_opsAuth.js';
import {
  handleLogin,
  handleLogout,
  handleMe,
  handleStats,
  handleTraces,
  handleRag,
  handleDefense,
  handleEvals,
  handleSystem,
  handleTraceDetail,
} from '../_opsRouteHandlers.js';

export const config = { runtime: 'nodejs' };

// Path segments after /api/ops/ — e.g. /api/ops/stats -> ['stats'],
// /api/ops/trace/<id> -> ['trace', '<id>']. Exported for unit testing.
export function parseOpsPath(rawUrl: string | undefined): string[] {
  const pathname = new URL(rawUrl ?? '/', 'http://localhost').pathname;
  const marker = '/api/ops/';
  const ix = pathname.indexOf(marker);
  const rest = ix >= 0 ? pathname.slice(ix + marker.length) : '';
  return rest.split('/').filter(Boolean).map(decodeURIComponent);
}

type OpsHandler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

// Single-segment GET data routes. trace/:id is handled separately (two
// segments). ['traces'] (list) is distinct from ['trace', id] (detail).
const DATA_HANDLERS: Record<string, OpsHandler> = {
  stats: handleStats,
  traces: handleTraces,
  rag: handleRag,
  defense: handleDefense,
  evals: handleEvals,
  system: handleSystem,
};

function methodNotAllowed(res: VercelResponse): void {
  res.status(405).send('method not allowed');
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const segs = parseOpsPath(req.url);
  const method = req.method ?? 'GET';
  const isGet = method === 'GET' || method === 'HEAD';

  // ---- auth routes (own auth behavior) ----
  if (segs.length === 1 && segs[0] === 'login') {
    if (method !== 'POST') return methodNotAllowed(res);
    return handleLogin(req, res);
  }
  if (segs.length === 1 && segs[0] === 'logout') {
    if (method !== 'POST') return methodNotAllowed(res);
    return handleLogout(req, res);
  }
  if (segs.length === 1 && segs[0] === 'me') {
    if (!isGet) return methodNotAllowed(res);
    return handleMe(req, res);
  }

  // ---- single-segment data routes (dispatcher guards the session) ----
  if (segs.length === 1) {
    const dataHandler = DATA_HANDLERS[segs[0]];
    if (dataHandler) {
      if (!isGet) return methodNotAllowed(res);
      if (!requireSession(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      return dataHandler(req, res);
    }
  }

  // ---- trace/:id detail (two segments) ----
  if (segs.length === 2 && segs[0] === 'trace') {
    if (!isGet) return methodNotAllowed(res);
    if (!requireSession(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    return handleTraceDetail(req, res, segs[1]);
  }

  res.status(404).json({ error: 'not found' });
}
