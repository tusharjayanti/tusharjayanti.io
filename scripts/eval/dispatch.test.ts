// Unit tests for the per-query dispatcher and the failure-rate math.
// Both are extracted from the main eval runner for testability —
// dispatchQuery is pure (deps-as-parameters, no closure state) and
// computeFailureRate is pure math.
//
// Two locks-in worth flagging:
//   - Only assertion-type queries trigger the skip path. A future
//     refactor accidentally gating retrieval on the availability check
//     would break the "retrieval-type queries are NOT affected" test.
//   - The threshold denominator is `attempted = total - skipped`,
//     not `total`. Skipped queries are invisible to the gate so
//     dormant queries can't shield real failures by inflating the
//     denominator (or, conversely, trip the gate by being counted as
//     errors when they were never run).

import { describe, it, expect } from 'vitest';

import {
  dispatchQuery,
  computeFailureRate,
  FAILURE_RATE_THRESHOLD,
  type Query,
  type DispatchDeps,
} from './retrieval.js';
import { getSupabaseClient } from '../../api/_supabase.js';

// Builds a DispatchDeps with optional overrides. The default supabase
// is a minimal RPC stub that returns empty data, which keeps
// processRetrievalQuery's call path happy without a live DB.
function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  const noopSupabase = {
    rpc: async () => ({ data: [], error: null }),
  } as unknown as ReturnType<typeof getSupabaseClient>;
  return {
    embedding: new Array(1024).fill(0),
    mode: 'three-tool',
    threshold: 0.3,
    rerank: false,
    supabase: noopSupabase,
    isResponseSourceAvailable: () => false,
    ...overrides,
  };
}

describe('dispatchQuery — assertion routing (D1 lock-in)', () => {
  it('routes assertion-type queries to skipped when response source unavailable', async () => {
    const q: Query = {
      id: 'ot-test',
      query: 'what is 55 times 65',
      result_type: 'assertion',
      category: 'off-topic',
      tags: ['off-topic'],
      assertions: [],
    };

    const outcome = await dispatchQuery(q, makeDeps());

    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.id).toBe('ot-test');
      expect(outcome.category).toBe('off-topic');
      expect(outcome.result_type).toBe('assertion');
      expect(outcome.reason).toBe('chat-endpoint-not-wired');
    }
  });

  it('does NOT skip retrieval-type queries when response source unavailable (operator-added lock-in)', async () => {
    // Locks in: the availability check gates assertion-type queries
    // ONLY. A future refactor that accidentally checks availability
    // for retrieval queries would break this test, which is the point.
    const q: Query = {
      id: 'Q-test',
      query: 'Tushar at DISCO',
      result_type: 'retrieval',
      category: 'rag-retrieval',
      target_source: 'experience',
      correct_chunks: [
        { source: 'experience', source_id: 'experience.md', chunk_index: 0 },
      ],
      tags: ['realistic'],
    };

    // isResponseSourceAvailable returns false (default) — should not
    // affect the routing of a retrieval query.
    const outcome = await dispatchQuery(q, makeDeps());

    expect(outcome.kind).toBe('retrieval');
  });

  it('routes the same assertion query to assertion (not skipped) when response source IS available', async () => {
    // Symmetric check: the gate is honored both ways. When the chat
    // endpoint is wired, the skip path doesn't fire — the query goes
    // through processAssertionQuery. processAssertionQuery itself
    // throws (the inner getResponseContext is still a stub), so the
    // outcome here is 'error', not 'skipped'. What matters for this
    // test is that 'skipped' is no longer the outcome.
    const q: Query = {
      id: 'ot-test',
      query: 'what is 55 times 65',
      result_type: 'assertion',
      category: 'off-topic',
      tags: ['off-topic'],
      assertions: [],
    };

    const outcome = await dispatchQuery(
      q,
      makeDeps({ isResponseSourceAvailable: () => true }),
    );

    expect(outcome.kind).not.toBe('skipped');
  });
});

describe('computeFailureRate — threshold math (D3 lock-in)', () => {
  it('uses attempted (= total - skipped) as the denominator: 1 failed of 5 attempted trips the gate at 20%', () => {
    // Today's near-miss shape, scaled: 20 queries total, 15 dormant
    // (skipped), 1 actual failure. Old logic: 1/20 = 5% → passes.
    // New logic: 1/5 = 20% → fails. This test asserts the new logic.
    const result = computeFailureRate({ total: 20, skipped: 15, failed: 1 });

    expect(result.attempted).toBe(5);
    expect(result.rate).toBeCloseTo(0.2, 6);
    expect(result.shouldFail).toBe(true);
    expect(result.rate).toBeGreaterThan(FAILURE_RATE_THRESHOLD);
  });

  it('PR-B-shaped scenario passes the gate cleanly: 20 dormant + 49 attempted with 0 failures', () => {
    // Anticipated PR B shape: 15 new dormant queries (refusal + injection
    // + canary-leak categories) on top of today's 5 off-topic = 20 dormant
    // total. 44 labeled retrieval + 5 OOC = 49 attempted, all succeed.
    // Gate should pass cleanly because the skipped queries don't shield
    // failures (there are none) — but also don't trip the gate by being
    // counted as errors.
    const result = computeFailureRate({ total: 69, skipped: 20, failed: 0 });

    expect(result.attempted).toBe(49);
    expect(result.rate).toBe(0);
    expect(result.shouldFail).toBe(false);
  });

  it('real retrieval errors still count: 6 failures of 50 attempted (12%) trips the gate even with 0 skipped', () => {
    // Locks in: the new denominator doesn't accidentally shield real
    // failures. If 12% of attempted queries truly errored, the run
    // still fails — the skipped-adjustment only changes the
    // denominator when there are skipped queries to remove.
    const result = computeFailureRate({ total: 50, skipped: 0, failed: 6 });

    expect(result.attempted).toBe(50);
    expect(result.rate).toBeCloseTo(0.12, 6);
    expect(result.shouldFail).toBe(true);
  });

  it('all-skipped run does not trip the gate (attempted = 0 short-circuits)', () => {
    // Edge case: if every query was skipped (no chat endpoint, no
    // retrieval queries authored), attempted is 0 and the rate is
    // undefined. We treat 0/0 as 0 and explicitly never fail on it —
    // a run that ran nothing has nothing to fail.
    const result = computeFailureRate({ total: 5, skipped: 5, failed: 0 });

    expect(result.attempted).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.shouldFail).toBe(false);
  });

  it('exactly at the threshold does NOT trip (strict greater-than)', () => {
    // Documents the boundary: rate must EXCEED the threshold, not
    // just match it. 1/10 = 10% exactly with threshold 10% passes.
    const result = computeFailureRate({ total: 10, skipped: 0, failed: 1 });

    expect(result.rate).toBeCloseTo(FAILURE_RATE_THRESHOLD, 6);
    expect(result.shouldFail).toBe(false);
  });
});
