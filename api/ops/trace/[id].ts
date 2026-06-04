// GET /api/ops/trace/:id — single conversation detail. Guarded. Fans out
// to Langfuse trace + observations + scores in parallel (opsTraceById) and
// shapes a master/detail payload incl. the span waterfall and an
// open-in-Langfuse deep-link. On-demand; the client caches it ~60s.

import type { VercelRequest, VercelResponse } from '../../_types.js';
import { requireSession } from '../../_opsAuth.js';
import { opsTraceById } from '../../_opsQuery.js';
import { buildDetail } from '../../_opsConversations.js';

export const config = { runtime: 'nodejs' };

const DEFAULT_BASE_URL = 'https://jp.cloud.langfuse.com';

function parseId(req: VercelRequest): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const last = url.pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : null;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('method not allowed');
    return;
  }
  if (!requireSession(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const id = parseId(req);
  if (!id || id === 'trace') {
    res.status(400).json({ error: 'missing trace id' });
    return;
  }

  const host = process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL;
  try {
    const { trace, observations, scores } = await opsTraceById(id);
    if (!trace) {
      res.status(404).json({ error: 'trace not found' });
      return;
    }
    res
      .setHeader('cache-control', 'no-store')
      .status(200)
      .json(buildDetail(trace, observations, scores, host));
  } catch (err) {
    console.error('[ops/trace] detail failed:', err);
    res.status(502).json({ error: 'detail failed' });
  }
}
