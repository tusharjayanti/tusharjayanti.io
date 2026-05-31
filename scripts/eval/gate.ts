// scripts/eval/gate.ts
//
// Phase 4b merge-gate comparator. PURE: takes the current run's EvalResult
// and the baseline EvalResult (or null on bootstrap) and returns a verdict.
// No I/O, no network, no env reads — the caller (runner entrypoint / CI step)
// owns loadBaseline(), the EVAL_ENABLED kill switch, and the process exit code.
// Kept side-effect-free on import so tests exercise it without booting the runner
// (same discipline as dispatch.ts).
//
// SCOPE BOUNDARY WITH PHASE 5:
// This module decides the SHAPE of the gate (what counts as a regression).
// The retrieval tolerance NUMBER is deferred to Phase 5, which tunes it against
// real drift data from 4b's automated runs. Until then retrievalTolerancePct is
// null = retrieval drift is reported but never blocks. Behavioral/assertion
// regressions hard-block immediately — those are correctness, not drift.
//
// UNIT ASSUMPTION: retrieval_at_1 / retrieval_at_5 / mrr are stored as fractions
// in [0,1] (e.g. 0.659), matching the "@1 65.9%" rendering elsewhere in the runner.

import type { EvalResult } from './result-writer.js';

export interface GateConfig {
  // null = retrieval drift is reported but does NOT block. Phase 5 sets a
  // percentage-point tolerance (e.g. 3 = block if a metric falls >3pp).
  retrievalTolerancePct: number | null;
  // false when the EVAL_ENABLED kill switch is off or a bypass label is present:
  // the gate no-ops to pass (with a warn reason for the audit trail).
  enabled: boolean;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  retrievalTolerancePct: null, // TODO(Phase 5): tune against accumulated drift data
  enabled: true,
};

export interface GateReason {
  severity: 'block' | 'warn';
  code: string;
  message: string;
}

export interface GateVerdict {
  passed: boolean; // false iff at least one reason has severity 'block'
  bootstrap: boolean; // true when no baseline existed (this run seeds it on merge)
  reasons: GateReason[];
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function compareToBaseline(
  current: EvalResult,
  baseline: EvalResult | null,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateVerdict {
  if (!config.enabled) {
    return {
      passed: true,
      bootstrap: baseline === null,
      reasons: [
        {
          severity: 'warn',
          code: 'gate-disabled',
          message:
            'Gate disabled (kill switch off or bypass label); not enforcing.',
        },
      ],
    };
  }

  const reasons: GateReason[] = [];

  // 1. Errored queries = infra/test breakage. Always block, baseline or not.
  const errored = current.per_query.filter((q) => q.error !== null);
  if (errored.length > 0) {
    reasons.push({
      severity: 'block',
      code: 'errored-queries',
      message: `${errored.length} query(ies) errored during execution: ${errored
        .map((q) => q.id)
        .join(', ')}.`,
    });
  }

  // Bootstrap: no baseline to compare against.
  if (baseline === null) {
    reasons.push({
      severity: 'warn',
      code: 'bootstrap',
      message:
        'No baseline found; a clean run seeds the baseline on merge to main.',
    });
    return { passed: errored.length === 0, bootstrap: true, reasons };
  }

  // 2a. Aggregate behavioral regression.
  const curA = current.aggregate.assertions;
  const baseA = baseline.aggregate.assertions;
  if (curA.pass_count < baseA.pass_count) {
    reasons.push({
      severity: 'block',
      code: 'assertion-passcount-drop',
      message: `Assertion pass_count dropped ${baseA.pass_count} → ${curA.pass_count}.`,
    });
  }

  // 2b. Named per-query regressions; skipped queries excluded.
  const baselinePassed = new Map(
    baseline.per_query.map((q) => [q.id, q.passed]),
  );
  const regressions = current.per_query.filter(
    (q) =>
      q.skipped !== true &&
      q.passed === false &&
      baselinePassed.get(q.id) === true,
  );
  if (regressions.length > 0) {
    reasons.push({
      severity: 'block',
      code: 'per-query-regression',
      message: `Queries that passed in baseline now fail: ${regressions
        .map((q) => q.id)
        .join(', ')}.`,
    });
  }

  // 2c. Per-category pass-rate drops, named for actionable PR comments.
  for (const [cat, cur] of Object.entries(curA.by_category)) {
    const base = baseA.by_category[cat];
    if (base && cur.pass_rate < base.pass_rate) {
      reasons.push({
        severity: 'block',
        code: 'category-passrate-drop',
        message: `Category "${cat}" pass_rate dropped ${pct(base.pass_rate)} → ${pct(cur.pass_rate)}.`,
      });
    }
  }

  // 3. Retrieval drift. Phase 5 owns the tolerance number; warn-only until set.
  const metrics: Array<[string, number, number]> = [
    [
      'retrieval@1',
      baseline.aggregate.retrieval.retrieval_at_1,
      current.aggregate.retrieval.retrieval_at_1,
    ],
    [
      'retrieval@5',
      baseline.aggregate.retrieval.retrieval_at_5,
      current.aggregate.retrieval.retrieval_at_5,
    ],
    ['mrr', baseline.aggregate.retrieval.mrr, current.aggregate.retrieval.mrr],
  ];
  for (const [name, base, cur] of metrics) {
    if (cur >= base) continue;
    const dropPp = (base - cur) * 100;
    const blocks =
      config.retrievalTolerancePct !== null &&
      dropPp > config.retrievalTolerancePct;
    reasons.push({
      severity: blocks ? 'block' : 'warn',
      code: 'retrieval-drift',
      message:
        `${name} dropped ${pct(base)} → ${pct(cur)} (−${dropPp.toFixed(1)}pp)` +
        (blocks
          ? `, exceeds tolerance ${config.retrievalTolerancePct}pp.`
          : ' (warn-only; Phase 5 tolerance unset).'),
    });
  }

  return {
    passed: !reasons.some((r) => r.severity === 'block'),
    bootstrap: false,
    reasons,
  };
}
