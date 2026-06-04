// GET /api/ops/evals — eval baseline-history. Guarded. Reads the committed
// per-commit result files (evals/results/by-commit/*.json) + the baseline
// pointer, then assembles the trend / category bars / gate status. The
// files ship with the function via vercel.json `includeFiles`.
//
// Cached 15 min — these files are immutable once written (one per commit),
// so a long TTL is safe and keeps cold reads off the 20-file parse.

import type { VercelRequest, VercelResponse } from '../_types.js';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';
import { requireSession } from '../_opsAuth.js';
import { cacheAside, type OpsStatsRedis } from '../_opsStats.js';
import { assembleEvals, type EvalsData } from '../_opsEvals.js';
import type {
  EvalResult,
  BaselinePointer,
} from '../../scripts/eval/result-writer.js';

export const config = { runtime: 'nodejs' };

const CACHE_TTL_SECONDS = 15 * 60;

function resultsDir(): string {
  return resolve(process.cwd(), 'evals', 'results');
}

async function readBaselineSha(): Promise<string | null> {
  const raw = await readFile(
    resolve(resultsDir(), 'baseline.json'),
    'utf-8',
  ).catch(() => null);
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as BaselinePointer).baseline_commit_sha ?? null;
  } catch {
    return null;
  }
}

async function readAllResults(): Promise<EvalResult[]> {
  const dir = resolve(resultsDir(), 'by-commit');
  const files = await readdir(dir).catch(() => [] as string[]);
  const jsons = files.filter((f) => f.endsWith('.json'));
  const out: EvalResult[] = [];
  for (const f of jsons) {
    const raw = await readFile(resolve(dir, f), 'utf-8').catch(() => null);
    if (raw === null) continue;
    try {
      out.push(JSON.parse(raw) as EvalResult);
    } catch {
      // skip an unparseable result file rather than 500 the whole tab.
    }
  }
  return out;
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

  let redis: OpsStatsRedis;
  try {
    redis = Redis.fromEnv() as unknown as OpsStatsRedis;
  } catch (err) {
    console.error('[ops/evals] Redis init failed:', err);
    res.status(503).json({ error: 'redis unavailable' });
    return;
  }

  try {
    const { data, cached, stale } = await cacheAside<EvalsData>(
      redis,
      'ops:evals',
      CACHE_TTL_SECONDS,
      async () => {
        const [results, baselineSha] = await Promise.all([
          readAllResults(),
          readBaselineSha(),
        ]);
        return assembleEvals(results, baselineSha);
      },
      { scheduleRefresh: waitUntil },
    );
    res
      .setHeader('cache-control', 'no-store')
      .setHeader('x-ops-cache', stale ? 'stale' : cached ? 'hit' : 'miss')
      .status(200)
      .json(data);
  } catch (err) {
    console.error('[ops/evals] assembly failed:', err);
    res.status(502).json({ error: 'assembly failed' });
  }
}
