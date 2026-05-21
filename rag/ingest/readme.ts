// README ingest orchestrator. Per-repo flow: fetch README from GitHub
// → chunk via sliding-window (chunkMarkdown(content, 'readme')) → for
// each chunk compute summary_input_hash = sha256(prev + this + next)
// → look up existing row at (readme, repoSlug, chunk_index) → if
// stored content_hash matches the target hash, skip everything (cache
// hit) → otherwise call Haiku to summarize, prepend the summary to
// the sliding-window embedding_text, embed via Voyage, upsert.
//
// Idempotency: the unified content_hash includes content +
// embedding_text + summary_input_hash, so a no-op re-run (same README
// bytes, same neighbors) skips all external calls. Token cost on
// cached re-runs is zero.
//
// What we DON'T do here:
// - Update /api/chat or expose search_readme. That's sub-spec 3.
// - Touch experience/resume rows. Non-readme sources keep their
//   exact deployed hash formula (see hashChunk in markdown.ts).

import { fetchReadme } from '../clients/github.js';
import { chunkMarkdown, type MarkdownChunk } from '../chunking/markdown.js';
import { embed } from '../../api/_voyage.js';
import {
  getSupabaseClient,
  type ChunkInput,
} from '../../api/_supabase.js';
import { summarizeChunk } from './haiku-summary.js';
import { hashChunk, sha256Hex } from './markdown.js';

const SUMMARY_SEPARATOR = '\n\n';

export type ReadmeIngestResult = {
  repo: string;
  total_chunks: number;
  created: number;
  updated: number;
  unchanged: number;
  summary_cache_hits: number;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  voyage_tokens: number;
};

function computeSummaryInputHash(
  chunks: MarkdownChunk[],
  index: number,
): string {
  const prev = index > 0 ? chunks[index - 1].content : '';
  const cur = chunks[index].content;
  const next = index < chunks.length - 1 ? chunks[index + 1].content : '';
  return sha256Hex(`${prev}\n---chunk---\n${cur}\n---chunk---\n${next}`);
}

// The README embedding_text is `summary + "\n\n" + sliding_window_embedding_text`.
// Splitting on the first '\n\n' recovers the cached summary. The
// sliding-window's own embedding_text (overlap-prepended content) is
// what comes after — preserved across cache lookups, regenerated on miss.
function composeEmbeddingText(
  summary: string,
  slidingWindowEmbeddingText: string,
): string {
  return `${summary}${SUMMARY_SEPARATOR}${slidingWindowEmbeddingText}`;
}

// Used in tests + the hit-path of the orchestrator: pull the cached
// summary back out of the stored embedding_text by splitting on the
// first occurrence of '\n\n'. Returns null if the stored text doesn't
// have the expected shape.
export function extractCachedSummary(
  embeddingText: string | null,
): string | null {
  if (!embeddingText) return null;
  const sepIdx = embeddingText.indexOf(SUMMARY_SEPARATOR);
  if (sepIdx === -1) return null;
  return embeddingText.slice(0, sepIdx);
}

export async function ingestReadme(
  repoSlug: string,
): Promise<ReadmeIngestResult> {
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) {
    throw new Error(
      `invalid repoSlug ${JSON.stringify(repoSlug)}; expected "<owner>/<repo>"`,
    );
  }

  const content = await fetchReadme(owner, repo);
  const slidingChunks = chunkMarkdown(content, 'readme');

  const result: ReadmeIngestResult = {
    repo: repoSlug,
    total_chunks: slidingChunks.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    summary_cache_hits: 0,
    haiku_input_tokens: 0,
    haiku_output_tokens: 0,
    voyage_tokens: 0,
  };

  if (slidingChunks.length === 0) {
    console.warn(
      `[ingest:readme] no chunks produced from ${repoSlug}; nothing to ingest`,
    );
    return result;
  }

  const supabase = getSupabaseClient();

  // Bulk-fetch existing rows for this (source, source_id). Used both
  // for the per-chunk cache check (content_hash compare) and for the
  // post-loop stale-chunk cleanup.
  const { data: existingRows, error: fetchError } = await supabase
    .from('chunks')
    .select('chunk_index, content_hash, embedding_text')
    .eq('source', 'readme')
    .eq('source_id', repoSlug);
  if (fetchError) throw fetchError;

  type ExistingRow = {
    content_hash: string;
    embedding_text: string | null;
  };
  const existing = new Map<number, ExistingRow>();
  for (const row of existingRows ?? []) {
    existing.set(row.chunk_index as number, {
      content_hash: row.content_hash as string,
      embedding_text: row.embedding_text as string | null,
    });
  }

  // Per-chunk: compute summary_input_hash, then ATTEMPT to short-
  // circuit on a cache hit. The cache hit comparison requires knowing
  // the full target hash, which depends on the eventual embedding_text
  // — which depends on the summary. To avoid calling Haiku just to
  // check the cache, we tentatively reuse the cached summary (if any)
  // and see if the resulting hash matches. If so, the row is already
  // correct — full skip. If not, we make a fresh Haiku call.
  type ToWrite = {
    chunkIndex: number;
    contentForRow: string;
    embeddingTextForRow: string;
    summaryInputHash: string;
    targetHash: string;
    metadata: Record<string, unknown>;
    needsEmbed: boolean;
    needsCreate: boolean;
    needsUpdate: boolean;
  };
  const toWrite: ToWrite[] = [];

  for (let i = 0; i < slidingChunks.length; i++) {
    const chunk = slidingChunks[i];
    const summaryInputHash = computeSummaryInputHash(slidingChunks, i);
    const existingRow = existing.get(i);

    // Cache-hit attempt: if there's a stored row, try recomposing
    // embedding_text from its cached summary + this chunk's
    // sliding-window embedding_text. If the resulting hash matches the
    // stored hash, neighbors and content are unchanged — skip both
    // Haiku AND Voyage.
    if (existingRow !== undefined) {
      const cachedSummary = extractCachedSummary(existingRow.embedding_text);
      if (cachedSummary !== null) {
        const candidateEmbeddingText = composeEmbeddingText(
          cachedSummary,
          chunk.embedding_text,
        );
        const candidateChunk: MarkdownChunk = {
          ...chunk,
          embedding_text: candidateEmbeddingText,
        };
        const candidateHash = hashChunk(
          candidateChunk,
          'readme',
          summaryInputHash,
        );
        if (candidateHash === existingRow.content_hash) {
          result.unchanged++;
          result.summary_cache_hits++;
          continue;
        }
      }
    }

    // Cache miss → call Haiku to generate a fresh summary, compose the
    // final embedding_text, mark for Voyage embed + upsert.
    const summaryResult = await summarizeChunk({
      prev: i > 0 ? slidingChunks[i - 1].content : null,
      current: chunk.content,
      next: i < slidingChunks.length - 1 ? slidingChunks[i + 1].content : null,
      repo: repoSlug,
      chunkOrder: i,
    });
    result.haiku_input_tokens += summaryResult.inputTokens;
    result.haiku_output_tokens += summaryResult.outputTokens;

    const finalEmbeddingText = composeEmbeddingText(
      summaryResult.summary,
      chunk.embedding_text,
    );
    const candidateChunk: MarkdownChunk = {
      ...chunk,
      embedding_text: finalEmbeddingText,
    };
    const targetHash = hashChunk(
      candidateChunk,
      'readme',
      summaryInputHash,
    );

    toWrite.push({
      chunkIndex: i,
      contentForRow: chunk.content,
      embeddingTextForRow: finalEmbeddingText,
      summaryInputHash,
      targetHash,
      metadata: { ...chunk.metadata },
      needsEmbed: true,
      needsCreate: existingRow === undefined,
      needsUpdate: existingRow !== undefined,
    });
  }

  // Single batched embedding call for every chunk that needs embedding.
  const toEmbed = toWrite.filter((w) => w.needsEmbed);
  let embeddings: number[][] = [];
  if (toEmbed.length > 0) {
    embeddings = await embed(
      toEmbed.map((w) => w.embeddingTextForRow),
      'document',
    );
    // Token usage approximation: Voyage doesn't expose it via the SDK,
    // but the document text fed in is a useful proxy. Sum chars/4 for
    // a rough token count.
    result.voyage_tokens = toEmbed.reduce(
      (acc, w) => acc + Math.ceil(w.embeddingTextForRow.length / 4),
      0,
    );
  }

  const rows: ChunkInput[] = toEmbed.map((w, i) => ({
    source: 'readme',
    source_id: repoSlug,
    chunk_index: w.chunkIndex,
    content: w.contentForRow,
    embedding: embeddings[i],
    embedding_text: w.embeddingTextForRow,
    metadata: w.metadata,
    content_hash: w.targetHash,
  }));

  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('chunks')
      .upsert(rows, { onConflict: 'source,source_id,chunk_index' });
    if (upsertError) throw upsertError;
  }

  for (const w of toWrite) {
    if (w.needsCreate) result.created++;
    else if (w.needsUpdate) result.updated++;
  }

  // Stale chunk cleanup: remove rows whose chunk_index no longer
  // appears in the new corpus.
  const newIndices = new Set(slidingChunks.map((_, i) => i));
  const staleIndices: number[] = [];
  for (const idx of existing.keys()) {
    if (!newIndices.has(idx)) staleIndices.push(idx);
  }
  if (staleIndices.length > 0) {
    const { error: deleteError } = await supabase
      .from('chunks')
      .delete()
      .eq('source', 'readme')
      .eq('source_id', repoSlug)
      .in('chunk_index', staleIndices);
    if (deleteError) throw deleteError;
  }

  return result;
}
