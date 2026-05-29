// Retrieval evaluation harness. Loads the labeled dataset from the
// per-category files evals/categories/{rag-retrieval,absent-facts}.json,
// embeds every query in one Voyage batch, calls retrieval per query, and
// computes metrics.
//
// Two retrieval modes — selected via `--mode=three-tool|unified` flag
// (default `three-tool`):
//
//   three-tool: calls `match_chunks` with the query's `target_source`
//               as the filter. Simulates the production /api/chat
//               tool-use loop where Sonnet picks one of three
//               search_<source> tools and that tool scopes retrieval.
//
//   unified:    calls `match_chunks_unified` (added in migration
//               0008) with no source filter. Simulates a hypothetical
//               single `search_portfolio` tool where retrieval ranks
//               globally across all chunks before any source-level
//               scoping happens.
//
// Cross-source queries (Q31): three-tool can't satisfy by design —
// labeled chunks span sources. Unified should be able to.
//
//   - retrieval@1 / @3 / @5: success rate over labeled queries
//   - MRR (mean reciprocal rank): 1/rank of first correct chunk
//   - guardrail firing rate: for `out-of-corpus` queries, % where
//     zero chunks land above the production 0.3 cosine floor
//
// Scoring conventions per query:
//   - default (any tag, non-empty correct_chunks): success at K =
//     "any correct chunk appears in top-K"
//   - cross-source: success at K = "ALL correct chunks appear in
//     top-K" (single-tool retrieval can't satisfy this by design;
//     these queries fail under the current three-tool pipeline,
//     succeed under a future unified retriever)
//   - out-of-corpus (correct_chunks empty): success = "zero chunks
//     above cosine 0.3" — the guardrail fires cleanly. Tracked as
//     guardrail_firing_rate, not retrieval@k.
//
// Output: stdout summary table + JSON results to
// evals/retrieval/results-<UTC-timestamp>.json so deltas across runs
// are diff-able.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embed, VOYAGE_MODEL } from '../../api/_voyage.js';
import { getSupabaseClient } from '../../api/_supabase.js';
import {
  rerankChunks,
  HAIKU_MODEL,
  type RerankerCandidate,
} from '../../api/_reranker.js';
import {
  writeResult,
  loadBaseline,
  gatherEnvMetadata,
  type EvalResult,
  type PerQueryResultEntry,
} from './result-writer.js';
import pLimit from 'p-limit';
import {
  runAssertions,
  type Assertion,
  type AssertionResult,
  type ResponseContext,
} from '../../evals/lib/assertions/index.js';

const DEFAULT_COSINE_FLOOR = 0.3;
const TOP_K = 10;

// Chat handler model id (mirrors api/chat.ts MODEL_ID). Not exercised by
// the retrieval-only runner; recorded in result metadata for provenance.
const RESPONSE_MODEL = 'claude-sonnet-4-6';

type Mode = 'three-tool' | 'unified';

function parseMode(): Mode {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  if (!arg) return 'three-tool';
  const value = arg.slice('--mode='.length);
  if (value !== 'three-tool' && value !== 'unified') {
    console.error(
      `invalid --mode value: ${value}. expected three-tool|unified`,
    );
    process.exit(2);
  }
  return value;
}

// M2.7 flag — when set, the eval pipes match_chunks output through
// the production reranker (api/_reranker.ts) before scoring. The
// "visible to the model" list becomes the reranker's diversified
// top-N, which is what production tool_results contain. Off by
// default so the M2.6 baseline runner stays reproducible.
function parseRerank(): boolean {
  return process.argv.includes('--rerank');
}

// Override the production cosine-similarity floor for this run. Used
// by the M2.6.5 threshold sweep — sub-spec 2 found that at the
// production default (0.3) the guardrail fires on 0/5 OOC queries,
// so the sweep tests higher floors. Override applies to BOTH the
// per-query retrieval@k computation (chunks below the floor are
// dropped from the LLM-visible list, matching production) AND the
// OOC guardrail firing rate.
function parseThreshold(): number {
  const arg = process.argv.find((a) => a.startsWith('--threshold='));
  if (!arg) return DEFAULT_COSINE_FLOOR;
  const value = arg.slice('--threshold='.length);
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.error(
      `invalid --threshold value: ${value}. expected number in [0, 1]`,
    );
    process.exit(2);
  }
  return parsed;
}

type ChunkRef = {
  source: 'experience' | 'resume' | 'readme' | 'docs';
  source_id?: string;
  chunk_index: number;
};

type Query = {
  id: string;
  query: string;
  // Required for retrieval-type queries (drives processRetrievalQuery's
  // source_filter and is asserted at the start of that function); not
  // used by the assertion path, so off-topic.json omits both fields.
  target_source?: 'experience' | 'resume' | 'readme' | 'docs';
  correct_chunks?: ChunkRef[];
  tags: string[];
  // M3 Phase 1a category-file fields. Present in the new structure; not
  // used by this runner's scoring (tags drive scoring; result_type is for
  // the Phase 3 assertion engine).
  result_type?: 'retrieval' | 'assertion';
  category?: string;
  // Assertion-type queries (Phase 1b) carry their assertion list here.
  assertions?: Assertion[];
  // M3 Phase 1b paraphrase entries carry this pointing at the canonical
  // query ID they paraphrase. Documentation-only today; not read by the
  // runner. Declared on the type so typos surface in tooling.
  paraphrase_of?: string;
};

type Dataset = {
  _meta: Record<string, unknown>;
  queries: Query[];
};

type MatchRow = {
  source: string;
  source_id: string;
  chunk_index: number;
  content: string;
  score: number;
  semantic_distance: number | null;
};

type PerQueryResult = {
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

// M3 Phase 1a: the eval set lives as per-category files under
// evals/categories/. This runner dispatches by `result_type`:
// retrieval-type queries go through `processRetrievalQuery` (scored
// against match_chunks); assertion-type queries go through
// `processAssertionQuery` and the Phase 3 assertion engine. Phase 1b
// adds off-topic.json (assertion-type, dormant until Phase 4 wires the
// chat endpoint) and paraphrase.json (retrieval-type). Queries are
// merged and re-sorted into their original Q-order so result files stay
// diff-comparable with pre-migration runs. The sort key strips the
// first character and parses the rest as a number; works for `Q1`/`Q31`
// and produces NaN-comparators for `arch-NNN`/`mf-NNN`/`para-NNN`/
// `ot-NNN` (treated as zero-difference → stable insertion order).
// Cosmetic only; see Followup #92 for the fix.
async function loadDataset(): Promise<Dataset> {
  const here = dirname(fileURLToPath(import.meta.url));
  const categoriesDir = resolvePath(here, '..', '..', 'evals', 'categories');
  const files = [
    'rag-retrieval.json',
    'absent-facts.json',
    'off-topic.json',
    'paraphrase.json',
  ];
  const queries: Query[] = [];
  for (const file of files) {
    const raw = await readFile(resolvePath(categoriesDir, file), 'utf-8');
    const parsed = JSON.parse(raw) as Dataset;
    queries.push(...parsed.queries);
  }
  queries.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { _meta: {}, queries };
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
  // Operates on visibleToModel — sub-spec 2 ran on `retrieved` (no
  // threshold filter), which inflated retrieval@k vs. what the LLM
  // actually saw. M2.6.5 sub-spec aligned this with production.
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

type Aggregate = {
  count: number;
  retrieval_at_1: number; // fraction in [0, 1]
  retrieval_at_3: number;
  retrieval_at_5: number;
  mrr: number;
};

function aggregateLabeled(results: PerQueryResult[]): Aggregate {
  const labeled = results.filter((r) => r.retrieval_at_1 !== null);
  if (labeled.length === 0) {
    return {
      count: 0,
      retrieval_at_1: 0,
      retrieval_at_3: 0,
      retrieval_at_5: 0,
      mrr: 0,
    };
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    count: labeled.length,
    retrieval_at_1:
      sum(labeled.map((r) => (r.retrieval_at_1 ? 1 : 0))) / labeled.length,
    retrieval_at_3:
      sum(labeled.map((r) => (r.retrieval_at_3 ? 1 : 0))) / labeled.length,
    retrieval_at_5:
      sum(labeled.map((r) => (r.retrieval_at_5 ? 1 : 0))) / labeled.length,
    mrr: sum(labeled.map((r) => r.reciprocal_rank ?? 0)) / labeled.length,
  };
}

function guardrailRate(results: PerQueryResult[]): {
  count: number;
  fired: number;
  rate: number;
} {
  const ooc = results.filter((r) => r.guardrail_fired !== null);
  const fired = ooc.filter((r) => r.guardrail_fired).length;
  return {
    count: ooc.length,
    fired,
    rate: ooc.length > 0 ? fired / ooc.length : 0,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// M3 Phase 2: map a scored retrieval result into the committed per-query
// result shape (spec §7.2). passed = guardrail fired (out-of-corpus) or a
// correct chunk in top-5 (everything else). Per-query latency/cost capture
// and Langfuse trace linkage land in Phase 3 (§8.5/§8.2); null here.
// response_text is null — this runner exercises retrieval only, not chat.
function toPerQueryEntry(
  r: PerQueryResult,
  category: string,
): PerQueryResultEntry {
  const passed =
    r.guardrail_fired !== null ? r.guardrail_fired : r.retrieval_at_5 === true;
  return {
    id: r.id,
    category,
    result_type: 'retrieval',
    passed,
    error: null,
    latency_seconds: null,
    cost_usd: null,
    retrieval_result: {
      rank_of_expected: r.first_correct_rank,
      top_k_returned: r.retrieved.map(
        (x) => `${x.source}:${x.source_id}#${x.chunk_index}`,
      ),
    },
    response_text: null,
    trace_id: null,
  };
}

function printSummary(results: PerQueryResult[]): void {
  console.log('\n=== Per-query results ===');
  for (const r of results) {
    const tagStr = r.tags.join(',');
    if (r.guardrail_fired !== null) {
      const status = r.guardrail_fired ? 'GUARDRAIL_FIRED' : 'guardrail_silent';
      console.log(
        `  ${r.id.padEnd(4)} [${tagStr}] ${status} chunks_above_floor=${r.chunks_above_floor}  q="${r.query}"`,
      );
    } else {
      const flags = [
        r.retrieval_at_1 ? '@1' : '  ',
        r.retrieval_at_3 ? '@3' : '  ',
        r.retrieval_at_5 ? '@5' : '  ',
      ].join(' ');
      const rank = r.first_correct_rank ?? '-';
      console.log(
        `  ${r.id.padEnd(4)} [${tagStr}] ${flags}  first_rank=${rank}  q="${r.query}"`,
      );
    }
  }

  const overall = aggregateLabeled(results);
  const guardrail = guardrailRate(results);
  console.log('\n=== Overall (labeled queries only) ===');
  console.log(`  labeled queries:   ${overall.count}`);
  console.log(`  retrieval@1:       ${pct(overall.retrieval_at_1)}`);
  console.log(`  retrieval@3:       ${pct(overall.retrieval_at_3)}`);
  console.log(`  retrieval@5:       ${pct(overall.retrieval_at_5)}`);
  console.log(`  MRR:               ${overall.mrr.toFixed(3)}`);
  console.log('\n=== Out-of-corpus (guardrail) ===');
  console.log(`  ooc queries:               ${guardrail.count}`);
  console.log(`  guardrail fired:           ${guardrail.fired}`);
  console.log(`  guardrail firing rate:     ${pct(guardrail.rate)}`);

  // Per-tag breakdown — every tag that appears in the labeled subset.
  console.log('\n=== Per-tag (labeled queries only) ===');
  const allTags = new Set<string>();
  for (const r of results.filter((r) => r.retrieval_at_1 !== null)) {
    for (const t of r.tags) allTags.add(t);
  }
  const sortedTags = [...allTags].sort();
  for (const tag of sortedTags) {
    const slice = results.filter(
      (r) => r.retrieval_at_1 !== null && r.tags.includes(tag),
    );
    if (slice.length === 0) continue;
    const agg = aggregateLabeled(slice);
    console.log(
      `  ${tag.padEnd(18)} n=${agg.count.toString().padStart(2)}  @1=${pct(agg.retrieval_at_1).padStart(6)}  @3=${pct(agg.retrieval_at_3).padStart(6)}  @5=${pct(agg.retrieval_at_5).padStart(6)}  MRR=${agg.mrr.toFixed(3)}`,
    );
  }

  // Failures: queries that didn't surface a correct chunk in top-5.
  const failures = results.filter((r) => r.retrieval_at_5 === false);
  if (failures.length > 0) {
    console.log('\n=== Failures @5 (correct chunk not in top-5) ===');
    for (const f of failures) {
      const labels = f.tags.join(',');
      console.log(
        `  ${f.id} [${labels}]  first_rank=${f.first_correct_rank ?? 'none'}  q="${f.query}"`,
      );
    }
  }

  // Guardrail silences: out-of-corpus queries that DIDN'T fire the
  // guardrail (fabrication risk).
  const guardrailSilent = results.filter((r) => r.guardrail_fired === false);
  if (guardrailSilent.length > 0) {
    console.log(
      '\n=== Guardrail silences (out-of-corpus queries with chunks above floor) ===',
    );
    for (const f of guardrailSilent) {
      console.log(
        `  ${f.id}  chunks_above_floor=${f.chunks_above_floor}  q="${f.query}"`,
      );
      const top = f.retrieved.filter((r) => r.above_floor).slice(0, 3);
      for (const t of top) {
        console.log(
          `      rank=${t.rank} cosine=${t.cosine_similarity?.toFixed(3) ?? '-'}  ${t.source_id} #${t.chunk_index}`,
        );
      }
    }
  }
}

const DEFAULT_CONCURRENCY = 8;
const FAILURE_RATE_THRESHOLD = 0.1;

function parseConcurrency(): number {
  const value = process.env.EVAL_CONCURRENCY;
  if (!value) return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONCURRENCY;
}

// One query's processing yields exactly one of these outcomes.
type QueryOutcome =
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
      kind: 'error';
      id: string;
      category: string;
      result_type: 'retrieval' | 'assertion';
      message: string;
    };

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

// Assertion-type query: obtain a chat ResponseContext, then evaluate its
// assertions. No assertion-type queries exist until Phase 1b, so this path
// is dormant; if reached before Phase 4 wires the endpoint it errors and
// is captured per-query.
async function processAssertionQuery(
  q: Query,
): Promise<{ assertions: AssertionResult[]; response: ResponseContext }> {
  const response = await getResponseContext(q);
  const assertions = await runAssertions(response, q.assertions ?? []);
  return { assertions, response };
}

function getResponseContext(_q: Query): Promise<ResponseContext> {
  // Producing a ResponseContext means calling /api/chat with the eval
  // traffic header (§8.2) against a deployed endpoint — wired in Phase 4
  // (workflow + endpoint URL + secrets). Until then there is no response
  // source, so this rejects clearly and the runner captures it per-query.
  return Promise.reject(
    new Error(
      'assertion-query execution needs the chat endpoint wired in Phase 4 (§8.2)',
    ),
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mode = parseMode();
  const threshold = parseThreshold();
  const dataset = await loadDataset();
  console.log(
    `loaded ${dataset.queries.length} queries from evals/categories/`,
  );
  console.log(`mode: ${mode}`);
  console.log(`threshold: ${threshold}`);

  console.log('embedding queries (1 Voyage batch)...');
  const { vectors: embeddings } = await embed(
    dataset.queries.map((q) => q.query),
    'query',
  );

  const rerank = parseRerank();
  if (rerank) {
    console.log(
      'rerank: ON (M2.7 reranker; threshold floor effectively 0 for scoring)',
    );
  }

  const supabase = getSupabaseClient();
  const concurrency = parseConcurrency();
  console.log(
    mode === 'three-tool'
      ? `running match_chunks against the three-tool baseline (concurrency=${concurrency})...`
      : `running match_chunks_unified across the whole corpus (concurrency=${concurrency})...`,
  );

  // M3 Phase 3 (§8.6): execute queries in parallel under a concurrency
  // cap. One query throwing does not abort the run — it is captured as an
  // error outcome and the run continues. Promise.all preserves input
  // order, so embeddings[i] stays aligned with dataset.queries[i].
  const limit = pLimit(concurrency);
  const outcomes = await Promise.all(
    dataset.queries.map((q, i) =>
      limit(async (): Promise<QueryOutcome> => {
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
            embeddings[i],
            mode,
            threshold,
            rerank,
            supabase,
          );
          return { kind: 'retrieval', scored };
        } catch (err) {
          console.error(`query ${q.id} failed:`, (err as Error).message);
          return {
            kind: 'error',
            id: q.id,
            category: q.category ?? 'unknown',
            result_type: q.result_type ?? 'retrieval',
            message: (err as Error).message,
          };
        }
      }),
    ),
  );

  const retrievalResults = outcomes
    .filter(
      (o): o is Extract<QueryOutcome, { kind: 'retrieval' }> =>
        o.kind === 'retrieval',
    )
    .map((o) => o.scored);
  const assertionOutcomes = outcomes.filter(
    (o): o is Extract<QueryOutcome, { kind: 'assertion' }> =>
      o.kind === 'assertion',
  );
  const errorOutcomes = outcomes.filter(
    (o): o is Extract<QueryOutcome, { kind: 'error' }> => o.kind === 'error',
  );

  printSummary(retrievalResults);

  // Legacy detailed JSON (retrieval only), retained until Phase 4.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const thrTag = `thr${threshold.toFixed(2)}`;
  const rerankTag = rerank ? '-rerank' : '';
  const outPath = resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'evals',
    'retrieval',
    `results-${mode}-${thrTag}${rerankTag}-${ts}.json`,
  );
  await mkdir(dirname(outPath), { recursive: true });
  const overall = aggregateLabeled(retrievalResults);
  const guardrail = guardrailRate(retrievalResults);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        run_at: new Date().toISOString(),
        mode,
        threshold,
        rerank,
        dataset_size: dataset.queries.length,
        overall,
        guardrail,
        results: retrievalResults,
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\nwrote results to ${outPath}`);

  // M3 Phase 2/3: emit the per-commit result file in the new format
  // (spec §7.2), covering retrieval + assertion + error outcomes.
  const env = await gatherEnvMetadata();
  const baseline = await loadBaseline();
  // Consistent fallback with the error-outcome category resolution above
  // (lines 644/664 use 'unknown'). Every query in every category file
  // sets `category` explicitly, so the fallback is purely defensive.
  const categoryById = new Map<string, string>(
    dataset.queries.map((q) => [q.id, q.category ?? 'unknown']),
  );
  const runtimeSeconds = (Date.now() - startedAt) / 1000;

  const retrievalEntries: PerQueryResultEntry[] = retrievalResults.map((r) =>
    toPerQueryEntry(r, categoryById.get(r.id) ?? 'unknown'),
  );
  const assertionEntries: PerQueryResultEntry[] = assertionOutcomes.map(
    (o) => ({
      id: o.id,
      category: o.category,
      result_type: 'assertion',
      passed: o.passed,
      error: null,
      latency_seconds: null,
      cost_usd: null,
      assertion_result: {
        assertions: o.assertions.map((a) => ({
          type: a.type,
          passed: a.passed,
          detail: a.detail,
        })),
      },
      response_text: o.responseText,
      trace_id: o.traceId,
    }),
  );
  const errorEntries: PerQueryResultEntry[] = errorOutcomes.map((o) => ({
    id: o.id,
    category: o.category,
    result_type: o.result_type,
    passed: false,
    error: o.message,
    latency_seconds: null,
    cost_usd: null,
    response_text: null,
    trace_id: null,
  }));

  // §8.6: per_query sorted by (category, id) for diff stability,
  // regardless of completion order.
  const perQuery = [
    ...retrievalEntries,
    ...assertionEntries,
    ...errorEntries,
  ].sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
  );

  // Assertion aggregate + per-category rollup.
  const assertionByCategory: Record<
    string,
    { query_count: number; pass_count: number; pass_rate: number }
  > = {};
  for (const o of assertionOutcomes) {
    const row = (assertionByCategory[o.category] ??= {
      query_count: 0,
      pass_count: 0,
      pass_rate: 0,
    });
    row.query_count += 1;
    if (o.passed) row.pass_count += 1;
  }
  for (const row of Object.values(assertionByCategory)) {
    row.pass_rate = row.query_count > 0 ? row.pass_count / row.query_count : 0;
  }
  const assertionPassCount = assertionOutcomes.filter((o) => o.passed).length;

  const totalQueries = dataset.queries.length;
  const failedQueries = errorOutcomes.length;
  const successfulQueries = totalQueries - failedQueries;

  const evalResult: EvalResult = {
    schema_version: '1.0.0',
    metadata: {
      commit_sha: env.commit_sha,
      branch: env.branch,
      pr_number: env.pr_number,
      timestamp: new Date().toISOString(),
      runtime_seconds: runtimeSeconds,
      eval_set_version: env.eval_set_version,
      eval_set_content_sha: env.eval_set_content_sha,
      baseline_commit_sha: baseline?.metadata.commit_sha ?? null,
      model_versions: {
        embedding: VOYAGE_MODEL,
        rerank: HAIKU_MODEL,
        response: RESPONSE_MODEL,
      },
      config_snapshot: {
        top_k_default: TOP_K,
        rerank_temperature: 0,
        eval_concurrency: concurrency,
      },
    },
    aggregate: {
      retrieval: {
        query_count: overall.count,
        retrieval_at_1: overall.retrieval_at_1,
        retrieval_at_5: overall.retrieval_at_5,
        mrr: overall.mrr,
        ooc_correct_rate: guardrail.rate,
      },
      assertions: {
        query_count: assertionOutcomes.length,
        pass_count: assertionPassCount,
        fail_count: assertionOutcomes.length - assertionPassCount,
        pass_rate:
          assertionOutcomes.length > 0
            ? assertionPassCount / assertionOutcomes.length
            : 0,
        by_category: assertionByCategory,
      },
      execution: {
        total_queries: totalQueries,
        successful_queries: successfulQueries,
        failed_queries: failedQueries,
        runtime_seconds: runtimeSeconds,
      },
    },
    per_query: perQuery,
  };
  const { path: perCommitPath } = await writeResult(evalResult);
  console.log(`wrote per-commit result to ${perCommitPath}`);

  // §8.6: a failure rate above the threshold fails the whole run,
  // regardless of metric thresholds — partial coverage is unsafe to gate on.
  if (
    totalQueries > 0 &&
    failedQueries / totalQueries > FAILURE_RATE_THRESHOLD
  ) {
    console.error(
      `eval run FAILED: ${failedQueries}/${totalQueries} queries errored ` +
        `(> ${(FAILURE_RATE_THRESHOLD * 100).toFixed(0)}% threshold)`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('eval:retrieval failed:', err);
  process.exit(1);
});
