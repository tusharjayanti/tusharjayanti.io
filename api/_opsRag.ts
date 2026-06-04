// Pure RAG aggregation for the RAG tab: retrieval outcomes + reranker
// stats over the window's real-human traces. Index counts come from
// Supabase (a count RPC, not a full-table fetch) and are merged in the
// api/ops/rag.ts handler.

import type { OpsRawTrace, OpsObservation } from './_opsQuery.js';

export interface RagOutcomes {
  total: number;
  retrieved: number; // retrieval fired (metadata.rag_retrieved)
  grounded: number; // produced a grounded answer (`grounded` tag)
  no_match: number; // retrieval ran but cleared the floor (rag_no_match)
  no_retrieval: number; // model answered without firing retrieval
}

export interface RerankerStats {
  runs: number;
  avg_latency_ms: number;
  total_cost_usd: number;
}

export interface IndexCount {
  source: string;
  chunks: number;
}

export interface RagStatsData {
  outcomes: RagOutcomes;
  reranker: RerankerStats;
  index_counts: IndexCount[] | null; // null when Supabase is unreachable
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function ragOutcomes(traces: OpsRawTrace[]): RagOutcomes {
  let retrieved = 0;
  let grounded = 0;
  let no_match = 0;
  for (const t of traces) {
    const md = t.metadata ?? {};
    if (md.rag_retrieved === true) retrieved += 1;
    if (md.rag_no_match === true) no_match += 1;
    if (t.tags.includes('grounded')) grounded += 1;
  }
  return {
    total: traces.length,
    retrieved,
    grounded,
    no_match,
    no_retrieval: traces.length - retrieved,
  };
}

// Reranker stats over observations scoped to the given trace ids (so eval
// / defense reranks dropped with their traces aren't counted).
export function rerankerStats(
  observations: OpsObservation[],
  keptIds: Set<string>,
): RerankerStats {
  const runs = observations.filter(
    (o) => o.name === 'rerank' && keptIds.has(o.traceId),
  );
  const n = runs.length;
  const avg =
    n === 0 ? 0 : (runs.reduce((a, o) => a + o.latency, 0) / n) * 1000;
  const cost = runs.reduce((a, o) => a + o.calculatedTotalCost, 0);
  return {
    runs: n,
    avg_latency_ms: Math.round(avg),
    total_cost_usd: round(cost, 6),
  };
}

export function ragStats(
  traces: OpsRawTrace[],
  observations: OpsObservation[],
): Omit<RagStatsData, 'index_counts'> {
  const keptIds = new Set(traces.map((t) => t.id));
  return {
    outcomes: ragOutcomes(traces),
    reranker: rerankerStats(observations, keptIds),
  };
}
