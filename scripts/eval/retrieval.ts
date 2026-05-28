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

import { embed } from '../../api/_voyage.js';
import { getSupabaseClient } from '../../api/_supabase.js';
import { rerankChunks, type RerankerCandidate } from '../../api/_reranker.js';

const DEFAULT_COSINE_FLOOR = 0.3;
const TOP_K = 10;

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
  source: 'experience' | 'resume' | 'readme';
  source_id?: string;
  chunk_index: number;
};

type Query = {
  id: string;
  query: string;
  target_source: 'experience' | 'resume' | 'readme';
  correct_chunks: ChunkRef[];
  tags: string[];
  // M3 Phase 1a category-file fields. Present in the new structure; not
  // used by this runner's scoring (tags drive scoring; result_type is for
  // the Phase 3 assertion engine).
  result_type?: 'retrieval' | 'assertion';
  category?: string;
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
// evals/categories/. This runner scores retrieval-type categories only
// (rag-retrieval + absent-facts); assertion categories authored in Phase
// 1b are handled by the Phase 3 assertion engine, not here. Queries are
// merged and re-sorted into their original Q-order so result files stay
// diff-comparable with pre-migration runs.
async function loadDataset(): Promise<Dataset> {
  const here = dirname(fileURLToPath(import.meta.url));
  const categoriesDir = resolvePath(here, '..', '..', 'evals', 'categories');
  const files = ['rag-retrieval.json', 'absent-facts.json'];
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

function scoreQuery(
  q: Query,
  rows: MatchRow[],
  threshold: number,
): PerQueryResult {
  const isCrossSource = q.tags.includes('cross-source');
  const isOutOfCorpus = q.tags.includes('out-of-corpus');

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
      is_correct: isChunkCorrect(r, q.correct_chunks),
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
      target_source: q.target_source,
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
      return q.correct_chunks.every((c) =>
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
    target_source: q.target_source,
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

async function main(): Promise<void> {
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
  const results: PerQueryResult[] = [];
  console.log(
    mode === 'three-tool'
      ? 'running match_chunks against the three-tool baseline...'
      : 'running match_chunks_unified across the whole corpus...',
  );
  for (let i = 0; i < dataset.queries.length; i++) {
    const q = dataset.queries[i];
    const emb = embeddings[i];
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
      console.error(`${rpcName} failed for ${q.id}:`, error);
      throw error;
    }
    let rows = (data ?? []) as MatchRow[];
    let effectiveThreshold = threshold;
    if (rerank) {
      // Pipe match_chunks output through the production reranker.
      // The reranker owns the cosine pre-filter (default 0.15) + the
      // Haiku verdict pass; its output is what the model would see
      // in tool_result. We override the eval's per-row threshold to
      // 0 so scoreQuery's own pre-filter doesn't double-clip.
      const { chunks: reranked } = await rerankChunks(
        q.query,
        rows as unknown as Array<MatchRow & RerankerCandidate>,
      );
      rows = reranked as unknown as MatchRow[];
      effectiveThreshold = 0;
    }
    results.push(scoreQuery(q, rows, effectiveThreshold));
  }

  printSummary(results);

  // Write detailed JSON for diffing across runs
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
  const overall = aggregateLabeled(results);
  const guardrail = guardrailRate(results);
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
        results,
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\nwrote results to ${outPath}`);
}

main().catch((err) => {
  console.error('eval:retrieval failed:', err);
  process.exit(1);
});
