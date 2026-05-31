// scripts/eval/gate.test.ts
//
// Locks in the Phase 4b gate's semantics — what blocks merge, what warns,
// what's invisible. Together these tests define the contract that Phase 5
// will extend (by setting a retrievalTolerancePct) without touching the
// shape of the verdict.

import { describe, expect, it } from 'vitest';

import {
  compareToBaseline,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
} from './gate.js';
import type { EvalResult, PerQueryResultEntry } from './result-writer.js';

// Fixture builder: a minimally-valid PerQueryResultEntry with sane defaults.
// Tests override only what they're exercising; everything else stays neutral.
function q(
  id: string,
  passed: boolean | null,
  extra: Partial<PerQueryResultEntry> = {},
): PerQueryResultEntry {
  return {
    id,
    category: extra.category ?? 'refusal',
    result_type: 'assertion',
    passed,
    error: null,
    latency_seconds: null,
    cost_usd: null,
    response_text: null,
    trace_id: null,
    ...extra,
  };
}

// EvalResult fixture with only the shape the gate inspects filled in
// meaningfully. metadata / model_versions / config_snapshot are filler the
// gate never reads.
function result(over: {
  per_query: PerQueryResultEntry[];
  pass_count: number;
  fail_count: number;
  by_category?: EvalResult['aggregate']['assertions']['by_category'];
  retrieval?: Partial<EvalResult['aggregate']['retrieval']>;
}): EvalResult {
  const queryCount = over.pass_count + over.fail_count;
  return {
    schema_version: '1',
    metadata: {
      commit_sha: 'abc',
      branch: 'main',
      pr_number: null,
      timestamp: '',
      runtime_seconds: 0,
      eval_set_version: '1.0.0',
      eval_set_content_sha: 'x',
      baseline_commit_sha: null,
      model_versions: { embedding: '', rerank: '', response: '' },
      config_snapshot: {
        top_k_default: 5,
        rerank_temperature: 0,
        eval_concurrency: 1,
      },
    },
    aggregate: {
      retrieval: {
        query_count: 0,
        retrieval_at_1: 0.66,
        retrieval_at_5: 0.86,
        mrr: 0.83,
        ooc_correct_rate: 1,
        ...over.retrieval,
      },
      assertions: {
        query_count: queryCount,
        pass_count: over.pass_count,
        fail_count: over.fail_count,
        pass_rate: queryCount ? over.pass_count / queryCount : 1,
        by_category: over.by_category ?? {},
      },
      execution: {
        total_queries: queryCount,
        successful_queries: over.pass_count,
        failed_queries: over.fail_count,
        skipped_queries: 0,
        runtime_seconds: 0,
      },
    },
    per_query: over.per_query,
  };
}

const cleanBaseline = result({
  per_query: [q('ref-001', true), q('ref-002', true)],
  pass_count: 2,
  fail_count: 0,
});

describe('compareToBaseline', () => {
  it('bootstraps to pass when baseline is null and run is clean', () => {
    const v = compareToBaseline(cleanBaseline, null);
    expect(v.passed).toBe(true);
    expect(v.bootstrap).toBe(true);
    expect(v.reasons.some((r) => r.code === 'bootstrap')).toBe(true);
  });

  it('blocks on errored queries even with no baseline', () => {
    const cur = result({
      per_query: [q('ref-001', null, { error: 'ECONNRESET' })],
      pass_count: 0,
      fail_count: 0,
    });
    const v = compareToBaseline(cur, null);
    expect(v.passed).toBe(false);
    expect(v.reasons.find((r) => r.code === 'errored-queries')?.severity).toBe(
      'block',
    );
  });

  it('passes when current equals baseline', () => {
    const v = compareToBaseline(cleanBaseline, cleanBaseline);
    expect(v.passed).toBe(true);
    expect(v.bootstrap).toBe(false);
  });

  it('blocks when a query that passed in baseline now fails', () => {
    const cur = result({
      per_query: [q('ref-001', true), q('ref-002', false)],
      pass_count: 1,
      fail_count: 1,
    });
    const v = compareToBaseline(cur, cleanBaseline);
    expect(v.passed).toBe(false);
    const r = v.reasons.find((x) => x.code === 'per-query-regression');
    expect(r?.severity).toBe('block');
    expect(r?.message).toContain('ref-002');
  });

  it('does not count newly-skipped queries as regressions', () => {
    const cur = result({
      per_query: [q('ref-001', true), q('ref-002', null, { skipped: true })],
      pass_count: 1,
      fail_count: 0,
    });
    const v = compareToBaseline(cur, cleanBaseline);
    expect(v.reasons.some((r) => r.code === 'per-query-regression')).toBe(
      false,
    );
  });

  it('blocks on a per-category pass-rate drop', () => {
    const base = result({
      per_query: [q('inj-001', true), q('inj-002', true)],
      pass_count: 2,
      fail_count: 0,
      by_category: {
        injection: { query_count: 2, pass_count: 2, pass_rate: 1 },
      },
    });
    const cur = result({
      per_query: [q('inj-001', true), q('inj-002', false)],
      pass_count: 1,
      fail_count: 1,
      by_category: {
        injection: { query_count: 2, pass_count: 1, pass_rate: 0.5 },
      },
    });
    const v = compareToBaseline(cur, base);
    expect(v.passed).toBe(false);
    expect(
      v.reasons.find((r) => r.code === 'category-passrate-drop')?.message,
    ).toContain('injection');
  });

  it('warns but does not block on retrieval drift when tolerance is unset (Phase 5)', () => {
    const cur = result({
      per_query: [q('ref-001', true), q('ref-002', true)],
      pass_count: 2,
      fail_count: 0,
      retrieval: { retrieval_at_1: 0.5 },
    });
    const v = compareToBaseline(cur, cleanBaseline);
    expect(v.passed).toBe(true);
    expect(v.reasons.find((r) => r.code === 'retrieval-drift')?.severity).toBe(
      'warn',
    );
  });

  it('blocks on retrieval drift once Phase 5 sets a tolerance', () => {
    const config: GateConfig = {
      ...DEFAULT_GATE_CONFIG,
      retrievalTolerancePct: 3,
    };
    const cur = result({
      per_query: [q('ref-001', true), q('ref-002', true)],
      pass_count: 2,
      fail_count: 0,
      retrieval: { retrieval_at_1: 0.5 },
    });
    const v = compareToBaseline(cur, cleanBaseline, config);
    expect(v.passed).toBe(false);
    expect(v.reasons.find((r) => r.code === 'retrieval-drift')?.severity).toBe(
      'block',
    );
  });

  it('no-ops to pass when the gate is disabled (kill switch / bypass)', () => {
    const config: GateConfig = { ...DEFAULT_GATE_CONFIG, enabled: false };
    const cur = result({
      per_query: [q('ref-001', false)],
      pass_count: 0,
      fail_count: 1,
    });
    const v = compareToBaseline(cur, cleanBaseline, config);
    expect(v.passed).toBe(true);
    expect(v.reasons.find((r) => r.code === 'gate-disabled')?.severity).toBe(
      'warn',
    );
  });
});
