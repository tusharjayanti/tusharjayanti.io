import { describe, it, expect } from 'vitest';

import { ragOutcomes, rerankerStats, ragStats } from './_opsRag.js';
import type { OpsRawTrace, OpsObservation } from './_opsQuery.js';

function t(
  id: string,
  tags: string[],
  md: Record<string, unknown>,
): OpsRawTrace {
  return {
    id,
    name: 'chat-turn',
    timestamp: '2026-05-22T08:00:00Z',
    tags,
    totalCost: 0.01,
    latency: 1.5,
    metadata: md,
    input: null,
    output: null,
    htmlPath: null,
    projectId: null,
    scores: [],
  };
}

function rerank(
  traceId: string,
  latency: number,
  cost: number,
): OpsObservation {
  return {
    id: `${traceId}-r`,
    traceId,
    name: 'rerank',
    model: 'claude-haiku-4-5',
    calculatedTotalCost: cost,
    latency,
    startTime: '2026-05-22T08:00:00Z',
  };
}

describe('ragOutcomes', () => {
  const traces = [
    t('a', ['grounded'], { rag_retrieved: true, rag_no_match: false }),
    t('b', ['grounded'], { rag_retrieved: true, rag_no_match: false }),
    t('c', [], { rag_retrieved: true, rag_no_match: true }), // fired, no match
    t('d', [], { rag_retrieved: false }), // model answered without retrieval
  ];
  it('buckets retrieval outcomes', () => {
    expect(ragOutcomes(traces)).toEqual({
      total: 4,
      retrieved: 3,
      grounded: 2,
      no_match: 1,
      no_retrieval: 1,
    });
  });
});

describe('rerankerStats', () => {
  it('scopes to kept trace ids and averages latency in ms', () => {
    const observations = [
      rerank('a', 0.2, 0.001),
      rerank('b', 0.4, 0.002),
      rerank('eval-x', 9, 9), // not in kept set — ignored
    ];
    const kept = new Set(['a', 'b']);
    expect(rerankerStats(observations, kept)).toEqual({
      runs: 2,
      avg_latency_ms: 300,
      total_cost_usd: 0.003,
    });
  });
  it('handles zero reranks without dividing by zero', () => {
    expect(rerankerStats([], new Set())).toEqual({
      runs: 0,
      avg_latency_ms: 0,
      total_cost_usd: 0,
    });
  });
});

describe('ragStats', () => {
  it('combines outcomes + reranker scoped to the traces', () => {
    const traces = [t('a', ['grounded'], { rag_retrieved: true })];
    const observations = [rerank('a', 0.2, 0.001), rerank('other', 1, 1)];
    const out = ragStats(traces, observations);
    expect(out.outcomes.retrieved).toBe(1);
    expect(out.reranker.runs).toBe(1); // 'other' excluded
  });
});
