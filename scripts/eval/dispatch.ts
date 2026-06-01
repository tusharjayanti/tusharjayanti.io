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
  type CitedSource,
  type ResponseContext,
} from '../../evals/lib/assertions/index.js';

// Eval-side cosine floor — the threshold at which the eval treats a
// retrieved chunk as "visible to the model" for retrieval@k scoring and
// for the OOC guardrail-firing-rate metric. Distinct from production's
// `RAG_MIN_COSINE_SIMILARITY` cost-control pre-filter (default 0.15 in
// api/_reranker.ts), which exists only to skip obvious noise before
// paying for Haiku; production's actual relevance gate is the Haiku
// reranker, not a scalar cosine. Tuned to 0.28 in M3 Phase 5 against
// the cosine distribution observed on the labeled set: hard-OOC max
// 0.243, in-corpus min 0.328 (Q10). 0.28 sits roughly mid-gap with a
// slight bias toward in-corpus margin. See
// docs/eval/ooc-threshold-tuning.md for the data and rationale.
export const DEFAULT_COSINE_FLOOR = 0.28;
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
  // M3 Phase 5 Sub-task C — phrase-bound entries contain a specific
  // trigger phrase the model is trained to refuse on the literal
  // phrasing; vocabulary-flexible entries express the same refusable
  // intent via paraphrase that doesn't share trigger phrases.
  // Documentation-only today; same convention as paraphrase_of.
  probe_type?: 'phrase_bound' | 'vocabulary_flexible';
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
  // Out-of-corpus only: did the guardrail fire? (zero chunks above the
  // current cosine floor — see DEFAULT_COSINE_FLOOR above).
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
      latencySeconds: number | null;
      costUsd: number | null;
    }
  | {
      // Pre-flight skip — assertion-type query where the chat endpoint
      // wasn't wired into the runner. Also fires post-flight when the
      // endpoint is configured but unreachable at request time
      // (ENOTFOUND / ECONNREFUSED) — a deploy outage shouldn't trip
      // the failure-rate gate. No execution attempted (pre-flight) or
      // executed but the call never reached the server (unreachable);
      // either way, invisible to the failure-rate gate.
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
// assertion-type query — i.e., both EVAL_CHAT_ENDPOINT_URL (where to
// send the request) and EVAL_BYPASS_SECRET (rate-limit bypass header
// secret) are set and non-empty. Either missing → assertion queries
// classify as skipped via the PR #24 path with
// skip_reason: 'chat-endpoint-not-wired'.
//
// Kept sync because a config check is sync, and a liveness ping would
// be over-engineering — an endpoint configured but unreachable
// surfaces in getResponseContext below, where ENOTFOUND / ECONNREFUSED
// classify as the same skipped outcome rather than a failure.
export function isResponseSourceAvailable(): boolean {
  return (
    typeof process.env.EVAL_CHAT_ENDPOINT_URL === 'string' &&
    process.env.EVAL_CHAT_ENDPOINT_URL.length > 0 &&
    typeof process.env.EVAL_BYPASS_SECRET === 'string' &&
    process.env.EVAL_BYPASS_SECRET.length > 0
  );
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
        latencySeconds:
          (response.trace.latency_seconds as number | undefined) ?? null,
        costUsd: (response.trace.cost_usd as number | undefined) ?? null,
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
    if (err instanceof EndpointUnreachableError) {
      return {
        kind: 'skipped',
        id: q.id,
        category: q.category ?? 'unknown',
        result_type: 'assertion',
        reason: 'endpoint-unreachable',
      };
    }
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

// Endpoint-unreachable error signal — thrown by getResponseContext
// when the chat endpoint can't be reached (DNS failure or TCP
// connection refused). dispatchQuery's catch maps this to the
// `skipped` outcome with reason 'endpoint-unreachable' so a deploy
// outage doesn't trip the failure-rate gate.
export class EndpointUnreachableError extends Error {
  readonly reason: string;
  constructor(reason: string, cause?: unknown) {
    super(
      `endpoint unreachable: ${reason}` +
        (cause instanceof Error ? ` (${cause.message})` : ''),
    );
    this.name = 'EndpointUnreachableError';
    this.reason = reason;
  }
}

// USD per million tokens, per Anthropic's published Claude Sonnet 4.6
// pricing (verify before launch / when model strings update). Match
// keys are prefixes — Anthropic sometimes returns dated model ids
// like "claude-sonnet-4-6-20251022"; we match by `startsWith`.
// Unknown model → cost_usd: null (soft degradation, not an error).
const PRICING_USD_PER_M_TOKENS: Record<
  string,
  {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  }
> = {
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cache_creation: 3.75,
    cache_read: 0.3,
  },
};

export type UsageEvent = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string | null;
};

export function computeCostUSD(usage: UsageEvent | null): number | null {
  if (!usage || !usage.model) return null;
  const priceKey = Object.keys(PRICING_USD_PER_M_TOKENS).find((k) =>
    usage.model!.startsWith(k),
  );
  if (!priceKey) return null;
  const p = PRICING_USD_PER_M_TOKENS[priceKey];
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_creation +
      usage.cache_read_input_tokens * p.cache_read) /
    1_000_000
  );
}

// Parses one line of the chat endpoint's NDJSON stream and folds it
// into the accumulating ResponseContext-in-progress. Exported so the
// stream-parser unit tests can drive it directly without spinning up
// fetch mocks. Throws on `{type:"error"}` events — the caller turns
// those into kind:'error' outcomes via dispatchQuery's catch.
export type StreamAccum = {
  text: string;
  trace_id: string | null;
  rag_used: boolean;
  sources: CitedSource[];
  usage: UsageEvent | null;
};

export function applyStreamEvent(accum: StreamAccum, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: { type?: string; [k: string]: unknown };
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return; // skip malformed lines
  }
  switch (evt.type) {
    case 'trace':
      accum.trace_id = (evt.traceId as string | null) ?? null;
      return;
    case 'delta':
      if (typeof evt.text === 'string') accum.text += evt.text;
      return;
    case 'rag':
      accum.rag_used = Boolean(evt.rag_used);
      if (Array.isArray(evt.sources)) {
        accum.sources = (evt.sources as unknown[])
          .filter((s): s is string => typeof s === 'string')
          .map((s) => ({ source: s }));
      }
      return;
    case 'usage':
      accum.usage = {
        input_tokens: Number(evt.input_tokens ?? 0),
        output_tokens: Number(evt.output_tokens ?? 0),
        cache_creation_input_tokens: Number(
          evt.cache_creation_input_tokens ?? 0,
        ),
        cache_read_input_tokens: Number(evt.cache_read_input_tokens ?? 0),
        model: typeof evt.model === 'string' ? evt.model : null,
      };
      return;
    case 'error':
      throw new Error(
        `chat endpoint emitted error event: ${String(evt.message ?? 'unknown')}`,
      );
    case 'done':
    default:
      return;
  }
}

async function getResponseContext(q: Query): Promise<ResponseContext> {
  const endpoint = process.env.EVAL_CHAT_ENDPOINT_URL;
  const secret = process.env.EVAL_BYPASS_SECRET;
  if (!endpoint || !secret) {
    // isResponseSourceAvailable should have prevented this — defensive.
    throw new Error('eval chat endpoint or bypass secret not configured');
  }

  const startMs = Date.now();
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eval-bypass': secret,
        'x-trace-source': 'eval',
        'x-eval-query-id': q.id,
      },
      body: JSON.stringify({ q: q.query }),
    });
  } catch (err) {
    // Node fetch wraps low-level errors; the actual code lives at
    // err.cause.code (e.g. fetch failed → cause = { code: 'ENOTFOUND' }).
    const code = extractFetchErrorCode(err);
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
      throw new EndpointUnreachableError(code, err);
    }
    throw err;
  }
  if (!resp.ok) {
    throw new Error(`chat endpoint returned HTTP ${resp.status}`);
  }
  if (!resp.body) {
    throw new Error('chat endpoint returned no response body');
  }

  const accum: StreamAccum = {
    text: '',
    trace_id: null,
    rag_used: false,
    sources: [],
    usage: null,
  };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      applyStreamEvent(accum, line);
    }
  }
  // Flush trailing partial line if any (shouldn't normally exist with
  // NDJSON's trailing newline, but be defensive).
  if (buffer.trim()) applyStreamEvent(accum, buffer);

  const latencyMs = Date.now() - startMs;

  return {
    text: accum.text,
    sources: accum.sources,
    rag_used: accum.rag_used,
    trace: {
      trace_id: accum.trace_id,
      latency_seconds: latencyMs / 1000,
      cost_usd: computeCostUSD(accum.usage),
      usage: accum.usage,
    },
  };
}

// Walks the (potentially wrapped) error chain to find a Node-style
// errno code. Node's fetch can surface ENOTFOUND/ECONNREFUSED either
// directly on the error or one level deeper as `err.cause.code`.
function extractFetchErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') return causeCode;
  }
  return null;
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
