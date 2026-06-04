// Pure shaping for the Evals tab: baseline-history trend (retrieval@1 +
// pass-rate over commits), latest-run category bars, and merge-gate status.
// The gate verdict reuses the production comparator (scripts/eval/gate.ts)
// so the dashboard reflects the SAME pass/fail semantics CI enforces — not
// a re-implementation that could drift. File I/O lives in api/ops/evals.ts.

import type { EvalResult } from '../scripts/eval/result-writer.js';
import { compareToBaseline, type GateVerdict } from '../scripts/eval/gate.js';

export interface TrendPoint {
  sha: string; // short (8)
  full_sha: string;
  branch: string;
  timestamp: string;
  retrieval_at_1: number;
  retrieval_at_5: number;
  mrr: number;
  pass_rate: number;
}

export interface CategoryBar {
  category: string;
  pass_rate: number;
  pass_count: number;
  query_count: number;
}

export interface EvalsData {
  run_count: number;
  baseline_sha: string | null;
  trend: TrendPoint[];
  latest: {
    sha: string;
    branch: string;
    timestamp: string;
    retrieval_at_1: number;
    retrieval_at_5: number;
    mrr: number;
    ooc_correct_rate: number;
    pass_rate: number;
    models: { embedding: string; rerank: string; response: string };
  } | null;
  categories: CategoryBar[];
  gate: GateVerdict | null;
}

export function buildEvalTrend(results: EvalResult[]): TrendPoint[] {
  return results
    .map((r) => ({
      sha: r.metadata.commit_sha.slice(0, 8),
      full_sha: r.metadata.commit_sha,
      branch: r.metadata.branch,
      timestamp: r.metadata.timestamp,
      retrieval_at_1: r.aggregate.retrieval.retrieval_at_1,
      retrieval_at_5: r.aggregate.retrieval.retrieval_at_5,
      mrr: r.aggregate.retrieval.mrr,
      pass_rate: r.aggregate.assertions.pass_rate,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function latestResult(results: EvalResult[]): EvalResult | null {
  if (results.length === 0) return null;
  return results.reduce((latest, r) =>
    r.metadata.timestamp > latest.metadata.timestamp ? r : latest,
  );
}

export function categoryBars(latest: EvalResult | null): CategoryBar[] {
  if (!latest) return [];
  return Object.entries(latest.aggregate.assertions.by_category)
    .map(([category, roll]) => ({
      category,
      pass_rate: roll.pass_rate,
      pass_count: roll.pass_count,
      query_count: roll.query_count,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// Assemble the full Evals payload. `baselineSha` is the commit the baseline
// pointer references; the matching result (if present) feeds the gate.
export function assembleEvals(
  results: EvalResult[],
  baselineSha: string | null,
): EvalsData {
  const latest = latestResult(results);
  const baseline =
    baselineSha != null
      ? (results.find((r) => r.metadata.commit_sha === baselineSha) ?? null)
      : null;

  return {
    run_count: results.length,
    baseline_sha: baselineSha,
    trend: buildEvalTrend(results),
    latest: latest
      ? {
          sha: latest.metadata.commit_sha.slice(0, 8),
          branch: latest.metadata.branch,
          timestamp: latest.metadata.timestamp,
          retrieval_at_1: latest.aggregate.retrieval.retrieval_at_1,
          retrieval_at_5: latest.aggregate.retrieval.retrieval_at_5,
          mrr: latest.aggregate.retrieval.mrr,
          ooc_correct_rate: latest.aggregate.retrieval.ooc_correct_rate,
          pass_rate: latest.aggregate.assertions.pass_rate,
          models: latest.metadata.model_versions,
        }
      : null,
    categories: categoryBars(latest),
    // Only meaningful when we have both a latest run and a distinct baseline.
    gate:
      latest && baseline && baseline !== latest
        ? compareToBaseline(latest, baseline)
        : null,
  };
}
