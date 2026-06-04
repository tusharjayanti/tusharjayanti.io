import { describe, it, expect } from 'vitest';

import {
  buildEvalTrend,
  latestResult,
  categoryBars,
  assembleEvals,
} from './_opsEvals.js';
import type { EvalResult } from '../scripts/eval/result-writer.js';

// Minimal EvalResult fixture — only the fields the ops shaping reads.
function result(
  sha: string,
  timestamp: string,
  over: {
    retrieval_at_1?: number;
    pass_rate?: number;
    by_category?: Record<
      string,
      { query_count: number; pass_count: number; pass_rate: number }
    >;
  } = {},
): EvalResult {
  return {
    schema_version: '1.1.0',
    metadata: {
      commit_sha: sha,
      branch: 'main',
      pr_number: null,
      timestamp,
      runtime_seconds: 1,
      eval_set_version: '1',
      eval_set_content_sha: 'x',
      baseline_commit_sha: null,
      model_versions: {
        embedding: 'voyage-3',
        rerank: 'haiku',
        response: 'sonnet',
      },
      config_snapshot: {
        top_k_default: 5,
        rerank_temperature: 0,
        eval_concurrency: 4,
      },
    },
    aggregate: {
      retrieval: {
        query_count: 44,
        retrieval_at_1: over.retrieval_at_1 ?? 0.68,
        retrieval_at_5: 0.86,
        mrr: 0.84,
        ooc_correct_rate: 0.61,
      },
      assertions: {
        query_count: 20,
        pass_count: 20,
        fail_count: 0,
        pass_rate: over.pass_rate ?? 1,
        by_category: over.by_category ?? {
          refusal: { query_count: 10, pass_count: 10, pass_rate: 1 },
          injection: { query_count: 10, pass_count: 9, pass_rate: 0.9 },
        },
      },
      execution: {
        total_queries: 64,
        successful_queries: 64,
        failed_queries: 0,
        skipped_queries: 0,
        runtime_seconds: 1,
      },
    },
    per_query: [],
  };
}

describe('buildEvalTrend', () => {
  it('shapes + sorts ascending by timestamp', () => {
    const trend = buildEvalTrend([
      result('bbbbbbbbbb', '2026-06-02T00:00:00Z', { retrieval_at_1: 0.7 }),
      result('aaaaaaaaaa', '2026-06-01T00:00:00Z', { retrieval_at_1: 0.6 }),
    ]);
    expect(trend.map((t) => t.sha)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(trend[0].retrieval_at_1).toBe(0.6);
    expect(trend[1].full_sha).toBe('bbbbbbbbbb');
  });
});

describe('latestResult', () => {
  it('returns the newest by timestamp, null when empty', () => {
    expect(latestResult([])).toBeNull();
    const latest = latestResult([
      result('a', '2026-06-01T00:00:00Z'),
      result('b', '2026-06-03T00:00:00Z'),
      result('c', '2026-06-02T00:00:00Z'),
    ]);
    expect(latest?.metadata.commit_sha).toBe('b');
  });
});

describe('categoryBars', () => {
  it('flattens by_category sorted by name', () => {
    const bars = categoryBars(
      result('a', '2026-06-01T00:00:00Z', {
        by_category: {
          injection: { query_count: 10, pass_count: 9, pass_rate: 0.9 },
          refusal: { query_count: 10, pass_count: 10, pass_rate: 1 },
        },
      }),
    );
    expect(bars.map((b) => b.category)).toEqual(['injection', 'refusal']);
    expect(bars[0].pass_rate).toBe(0.9);
  });
  it('returns [] for null latest', () => {
    expect(categoryBars(null)).toEqual([]);
  });
});

describe('assembleEvals', () => {
  const runs = [
    result('base000000', '2026-06-01T00:00:00Z', { pass_rate: 1 }),
    result('head000000', '2026-06-02T00:00:00Z', { pass_rate: 1 }),
  ];

  it('assembles trend + latest + categories + a real gate verdict', () => {
    const data = assembleEvals(runs, 'base000000');
    expect(data.run_count).toBe(2);
    expect(data.baseline_sha).toBe('base000000');
    expect(data.trend).toHaveLength(2);
    expect(data.latest?.sha).toBe('head0000');
    expect(data.categories.length).toBeGreaterThan(0);
    // latest == baseline pass_rate (1 vs 1) → gate passes, not bootstrap.
    expect(data.gate?.passed).toBe(true);
    expect(data.gate?.bootstrap).toBe(false);
  });

  it('blocks the gate on a per-category pass-rate regression', () => {
    const regressed = [
      result('base000000', '2026-06-01T00:00:00Z'), // injection cat @ 0.9
      result('head000000', '2026-06-02T00:00:00Z', {
        by_category: {
          refusal: { query_count: 10, pass_count: 10, pass_rate: 1 },
          injection: { query_count: 10, pass_count: 5, pass_rate: 0.5 }, // drop
        },
      }),
    ];
    const data = assembleEvals(regressed, 'base000000');
    expect(data.gate?.passed).toBe(false);
    expect(
      data.gate?.reasons.some((r) => r.code === 'category-passrate-drop'),
    ).toBe(true);
  });

  it('null gate when no distinct baseline is present', () => {
    const data = assembleEvals([runs[1]], null);
    expect(data.gate).toBeNull();
    expect(data.latest?.sha).toBe('head0000');
  });
});
