// Per-query dispatcher + failure-rate math + their pure helpers.
// Extracted from retrieval.ts so test files can import the dispatch
// primitives without triggering the eval runner as a side effect of
// ESM module evaluation. This module does NOT call anything at
// import time — every export is a value or function the caller must
// invoke explicitly.
//
// retrieval.ts is the script entrypoint that wires this up; the
// runner orchestration lives in runEvalRetrieval.ts.

import { getSupabaseClient } from '../../api/_supabase.js';
import { rerankChunks, type RerankerCandidate } from '../../api/_reranker.js';
import {
  runAssertions,
  type Assertion,
  type AssertionResult,
  type ResponseContext,
} from '../../evals/lib/assertions/index.js';

export const DEFAULT_COSINE_FLOOR = 0.3;
export const TOP_K = 10;
export const FAILURE_RATE_THRESHOLD = 0.1;

export type Mode = 'three-tool' | 'unified';

type ChunkRef = {
  source: 'experience' | 'resume' | 'readme' | 'docs';
  source_id?: string;
  chunk_index: number;
};

export type Query = {
  id: string;
  query: string;
  // Required for retrieval-type queries (drives processRetrievalQuery's
  // source_filter and is asserted at the start of that function); not
  // used by the assertion path, so off-topic.json omits both fields.
  target_source?: 'experience' | 'resume' | 'readme' | 'docs';
  correct_chunks?: ChunkRef[];
  tags: string[];
  // Category-file fields. Present in the structure; not used by this
  // runner's scoring (tags drive scoring; result_type is for the
  // assertion engine).
  result_type?: 'retrieval' | 'assertion';
  category?: string;
  // Assertion-type queries carry their assertion list here.
  assertions?: Assertion[];
  // Paraphrase entries carry this pointing at the canonical query ID
  // they paraphrase. Documentation-only today; not read by the runner.
  // Declared on the type so typos surface in tooling.
  paraphrase_of?: string;
};

type MatchRow = {
  source: string;
  source_id: string;
  chunk_index: number;
  content: string;
  score: number;
  semantic_distance: number | null;
};

export type PerQueryResult = {
  id: string;
  query: string;
  target_source: string;
  tags: string[];
  // Top-10 chunks the runner saw, plus a marker on which (if any)
  // are labeled correct. Useful for failure analysis.
  retrieved: Array<{
    rank: number;
    source: string;
    source_id: string;
    chunk_index: number;
    score: number;
    semantic_distance: number | null;
    cosine_similarity: number | null;
    is_correct: boolean;
    above_floor: boolean;
  }>;
  // Standard retrieval@K (or null for out-of-corpus). For
  // cross-source, "success" requires ALL correct chunks in top-K.
  retrieval_at_1: boolean | null;
  retrieval_at_3: boolean | null;
  retrieval_at_5: boolean | null;
  // 1-indexed rank of the first correct chunk in top-10, or null if
  // not found (or out-of-corpus).
  first_correct_rank: number | null;
  reciprocal_rank: number | null;
  // Out-of-corpus only: did the guardrail fire? (zero chunks above
  // 0.3 cosine).
  guardrail_fired: boolean | null;
  chunks_above_floor: number;
};

// One query's processing yields exactly one of these outcomes.
export type QueryOutcome =
  | { kind: 'retrieval'; scored: PerQueryResult }
  | {
      kind: 'assertion';
      id: string;
      category: string;
      passed: boolean;
      assertions: AssertionResult[];
      responseText: string | null;
      traceId: string | null;
    }
  | {
      // Pre-flight skip — assertion-type query where the chat endpoint
      // wasn't wired into the runner. No execution attempted; invisible
      // to the failure-rate gate.
      kind: 'skipped';
      id: string;
      category: string;
      result_type: 'assertion';
      reason: string;
    }
  | {
      kind: 'error';
      id: string;
      category: string;
      result_type: 'retrieval' | 'assertion';
      message: string;
    };

// Dependencies dispatchQuery needs. Passed in explicitly rather than
// reaching into module-scope state so tests can mock each independently.
export interface DispatchDeps {
  embedding: number[];
  mode: Mode;
  threshold: number;
  rerank: boolean;
  supabase: ReturnType<typeof getSupabaseClient>;
  isResponseSourceAvailable: () => boolean;
}

// Returns true when the runner can produce a ResponseContext for an
// assertion-type query — i.e., the chat endpoint URL + credentials
// are configured. Returns false today; the production wiring lands in
// a later iteration. Kept sync because a config check is sync, and a
// liveness ping would be over-engineering — an endpoint configured
// but unreachable already surfaces as a per-query error via the
// per-query catch in dispatchQuery.
export function isResponseSourceAvailable(): boolean {
  return false;
}

// Pure threshold math, extracted for testability. Skipped queries are
// invisible to both numerator and denominator on purpose — see
// ExecutionAggregate's `successful_queries` comment. attempted = 0
// (everything was skipped) trips no gate; the run can't fail on a
// rate computed against zero.
export function computeFailureRate(args: {
  total: number;
  skipped: number;
  failed: number;
}): { attempted: number; rate: number; shouldFail: boolean } {
  const attempted = args.total - args.skipped;
  const rate = attempted > 0 ? args.failed / attempted : 0;
  return {
    attempted,
    rate,
    shouldFail: attempted > 0 && rate > FAILURE_RATE_THRESHOLD,
  };
}

// Pure dispatch: maps a Query to an outcome. Side-effect-free — the
// caller is responsible for logging based on the returned outcome
// kind. Catching is per-query so one failure doesn't abort the run.
export async function dispatchQuery(
  q: Query,
  deps: DispatchDeps,
): Promise<QueryOutcome> {
  // Pre-flight skip path. Only assertion-type queries qualify;
  // retrieval-type queries are unaffected by isResponseSourceAvailable
  // (locked in by a dedicated test).
  if (q.result_type === 'assertion' && !deps.isResponseSourceAvailable()) {
    return {
      kind: 'skipped',
      id: q.id,
      category: q.category ?? 'unknown',
      result_type: 'assertion',
      reason: 'chat-endpoint-not-wired',
    };
  }

  try {
    if (q.result_type === 'assertion') {
      const { assertions, response } = await processAssertionQuery(q);
      return {
        kind: 'assertion',
        id: q.id,
        category: q.category ?? 'unknown',
        passed: assertions.every((a) => a.passed),
        assertions,
        responseText: response.text,
        traceId: (response.trace.trace_id as string | undefined) ?? null,
      };
    }
    const scored = await processRetrievalQuery(
      q,
      deps.embedding,
      deps.mode,
      deps.threshold,
      deps.rerank,
      deps.supabase,
    );
    return { kind: 'retrieval', scored };
  } catch (err) {
    return {
      kind: 'error',
      id: q.id,
      category: q.category ?? 'unknown',
      result_type: q.result_type ?? 'retrieval',
      message: (err as Error).message,
    };
  }
}

// Retrieval-type query: match_chunks (+ optional rerank) then score.
// Both `target_source` and `correct_chunks` are required here; they're
// declared optional on Query because assertion-type queries (off-topic)
// don't carry them. A retrieval-type entry missing either is an author
// error — surface it loudly rather than silently scoring against junk.
async function processRetrievalQuery(
  q: Query,
  emb: number[],
  mode: Mode,
  threshold: number,
  rerank: boolean,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<PerQueryResult> {
  if (!q.target_source) {
    throw new Error(`retrieval query ${q.id} missing target_source`);
  }
  if (!q.correct_chunks) {
    throw new Error(`retrieval query ${q.id} missing correct_chunks`);
  }
  const rpcName =
    mode === 'three-tool' ? 'match_chunks' : 'match_chunks_unified';
  const rpcArgs: Record<string, unknown> =
    mode === 'three-tool'
      ? {
          query_embedding: emb,
          query_text: q.query,
          match_count: TOP_K,
          source_filter: q.target_source,
        }
      : {
          query_embedding: emb,
          query_text: q.query,
          match_count: TOP_K,
        };
  const { data, error } = await supabase.rpc(rpcName, rpcArgs);
  if (error) {
    throw new Error(`${rpcName} failed: ${error.message ?? String(error)}`);
  }
  let rows = (data ?? []) as MatchRow[];
  let effectiveThreshold = threshold;
  if (rerank) {
    // Pipe match_chunks output through the production reranker. The
    // reranker owns the cosine pre-filter (default 0.15) + the Haiku
    // verdict pass; its output is what the model sees in tool_result. We
    // override the per-row threshold to 0 so scoreQuery doesn't double-clip.
    const { chunks: reranked } = await rerankChunks(
      q.query,
      rows as unknown as Array<MatchRow & RerankerCandidate>,
    );
    rows = reranked as unknown as MatchRow[];
    effectiveThreshold = 0;
  }
  return scoreQuery(q, rows, effectiveThreshold);
}

// Assertion-type query: obtain a chat ResponseContext, then evaluate
// its assertions. This path is dormant until the chat endpoint is
// wired into the runner; if reached before that it errors and is
// captured per-query.
async function processAssertionQuery(
  q: Query,
): Promise<{ assertions: AssertionResult[]; response: ResponseContext }> {
  const response = await getResponseContext(q);
  const assertions = await runAssertions(response, q.assertions ?? []);
  return { assertions, response };
}

function getResponseContext(_q: Query): Promise<ResponseContext> {
  // Producing a ResponseContext means calling /api/chat with the eval
  // traffic header against a deployed endpoint — wired later (workflow
  // + endpoint URL + secrets). Until then there is no response source,
  // so this rejects clearly and the runner captures it per-query.
  return Promise.reject(
    new Error(
      'assertion-query execution needs the chat endpoint wired into the runner',
    ),
  );
}

function isChunkCorrect(row: MatchRow, correct: ChunkRef[]): boolean {
  return correct.some((c) => {
    if (row.source !== c.source) return false;
    if (c.source_id !== undefined && row.source_id !== c.source_id)
      return false;
    return row.chunk_index === c.chunk_index;
  });
}

// scoreQuery is only called from processRetrievalQuery, which guards
// that `target_source` and `correct_chunks` are both defined before
// dispatch. Within scoreQuery we treat them as definite.
function scoreQuery(
  q: Query,
  rows: MatchRow[],
  threshold: number,
): PerQueryResult {
  const isCrossSource = q.tags.includes('cross-source');
  const isOutOfCorpus = q.tags.includes('out-of-corpus');
  const correctChunks = q.correct_chunks ?? [];
  const targetSource = q.target_source ?? '';

  // Decorate every retrieved chunk with correctness + above-floor
  // markers. Cosine similarity = 1 - semantic_distance; null when the
  // chunk only surfaced via BM25 (no semantic anchor) — those are
  // treated as below-floor regardless of `threshold` because we want
  // a semantic-relevance gate, not a lexical-only one (matches the
  // production guardrail filter in api/_tools.ts).
  const retrieved = rows.slice(0, TOP_K).map((r, idx) => {
    const cosine =
      r.semantic_distance === null ? null : 1 - r.semantic_distance;
    return {
      rank: idx + 1,
      source: r.source,
      source_id: r.source_id,
      chunk_index: r.chunk_index,
      score: r.score,
      semantic_distance: r.semantic_distance,
      cosine_similarity: cosine,
      is_correct: isChunkCorrect(r, correctChunks),
      above_floor: cosine !== null && cosine >= threshold,
    };
  });

  // The LLM-visible list is what survived the threshold filter — this
  // matches what api/_tools.ts hands to Sonnet as tool_result content.
  // retrieval@k is measured against this filtered list (chunks below
  // the floor are invisible to the model and can't count as "found"),
  // and ranks are 1-indexed within it.
  const visibleToModel = retrieved.filter((r) => r.above_floor);
  const chunksAboveFloor = visibleToModel.length;

  if (isOutOfCorpus) {
    return {
      id: q.id,
      query: q.query,
      target_source: targetSource,
      tags: q.tags,
      retrieved,
      retrieval_at_1: null,
      retrieval_at_3: null,
      retrieval_at_5: null,
      first_correct_rank: null,
      reciprocal_rank: null,
      guardrail_fired: chunksAboveFloor === 0,
      chunks_above_floor: chunksAboveFloor,
    };
  }

  // Standard / cross-source scoring. "Hit" semantics differ per tag.
  // Operates on visibleToModel — an earlier version ran on `retrieved`
  // (no threshold filter), which inflated retrieval@k vs. what the LLM
  // actually saw. Aligned with production.
  const correctInTopK = (k: number): boolean => {
    const slice = visibleToModel.slice(0, k).filter((r) => r.is_correct);
    if (isCrossSource) {
      return correctChunks.every((c) =>
        slice.some(
          (r) =>
            r.source === c.source &&
            (c.source_id === undefined || r.source_id === c.source_id) &&
            r.chunk_index === c.chunk_index,
        ),
      );
    }
    return slice.length > 0;
  };

  // Re-rank to 1-indexed position within visibleToModel.
  const firstCorrectIdx = visibleToModel.findIndex((r) => r.is_correct);
  const rank = firstCorrectIdx >= 0 ? firstCorrectIdx + 1 : null;

  return {
    id: q.id,
    query: q.query,
    target_source: targetSource,
    tags: q.tags,
    retrieved,
    retrieval_at_1: correctInTopK(1),
    retrieval_at_3: correctInTopK(3),
    retrieval_at_5: correctInTopK(5),
    first_correct_rank: rank,
    reciprocal_rank: rank !== null ? 1 / rank : 0,
    guardrail_fired: null,
    chunks_above_floor: chunksAboveFloor,
  };
}
