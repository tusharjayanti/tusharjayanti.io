// Generic markdown-source ingest pipeline used by every markdown-backed
// RAG corpus (experience.md, resume.md, READMEs, docs). Reads the file
// from disk, hands off to the per-source
// chunker dispatcher, diffs against existing rows in `chunks` (matched
// by source/source_id/chunk_index), embeds only the rows that are new
// or whose content_hash changed, upserts via the
// (source, source_id, chunk_index) unique key, and deletes any rows
// whose chunk_index no longer appears in the new chunk set (covers the
// "section deleted from the corpus" case). File paths are resolved
// against process.cwd() so callers stay agnostic to where the script
// lives.
//
// Sub-spec 1 changes: the chunker is now per-source dispatched, and
// each chunk carries both `content` (clean display text) and
// `embedding_text` (what we embed into the dense vector). The
// content_hash combines both so re-embedding fires whenever either
// changes — important when only the heading-path prefix logic gets
// tweaked but bodies don't.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chunkMarkdown, type MarkdownChunk } from '../chunking/markdown.js';
import { embed } from '../../api/_voyage.js';
import {
  getSupabaseClient,
  type ChunkInput,
  type ChunkSource,
} from '../../api/_supabase.js';

export type IngestResult = {
  total_chunks: number;
  created: number;
  updated: number;
  unchanged: number;
  tokens_embedded: number;
};

export type IngestOptions = {
  filePath: string;
  source: ChunkSource;
  source_id: string;
};

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// Hash bundles `content` + `embedding_text` so a future change to
// embedding_text construction (e.g., a different heading-path format)
// forces a re-embed even when content is byte-identical.
//
// Source-conditional: README rows extend the input with a
// `summary_input_hash` derived from neighbor chunks. That lets the
// Haiku-summary step share a single cache key with the embedding —
// when the chunk OR either neighbor changes, the chunk re-summarizes
// AND re-embeds together. Non-readme sources keep the exact deployed
// formula so the rows hash to byte-identical values. The literal
// `'<none>'` sentinel from the original design is replaced by "don't
// append the suffix at all" — same operational outcome, and
// arithmetically valid (sha256(A + B) ≠ sha256(A)).
export function hashChunk(
  chunk: MarkdownChunk,
  source: ChunkSource,
  summaryInputHash?: string,
): string {
  const base = `${chunk.content}\n---embedding---\n${chunk.embedding_text}`;
  if (source === 'readme') {
    return sha256Hex(
      `${base}\n---summary_input_hash---\n${summaryInputHash ?? ''}`,
    );
  }
  return sha256Hex(base);
}

export async function ingestMarkdownSource(
  opts: IngestOptions,
): Promise<IngestResult> {
  const resolvedPath = resolve(process.cwd(), opts.filePath);
  const markdown = await readFile(resolvedPath, 'utf-8');
  const chunks = chunkMarkdown(markdown, opts.source);

  if (chunks.length === 0) {
    console.warn(
      `[ingest:${opts.source}] no chunks produced from ${opts.source_id}; nothing to ingest`,
    );
    return {
      total_chunks: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      tokens_embedded: 0,
    };
  }

  const client = getSupabaseClient();

  const { data: existingRows, error: fetchError } = await client
    .from('chunks')
    .select('chunk_index, content_hash')
    .eq('source', opts.source)
    .eq('source_id', opts.source_id);
  if (fetchError) throw fetchError;

  const existing = new Map<number, string>();
  for (const row of existingRows ?? []) {
    existing.set(row.chunk_index as number, row.content_hash as string);
  }

  // Classify against existing rows. We embed only what needs to change.
  const toEmbed: { chunk: MarkdownChunk; hash: string }[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const chunk of chunks) {
    const hash = hashChunk(chunk, opts.source);
    const prevHash = existing.get(chunk.chunk_index);
    if (prevHash === undefined) {
      created++;
      toEmbed.push({ chunk, hash });
    } else if (prevHash === hash) {
      unchanged++;
    } else {
      updated++;
      toEmbed.push({ chunk, hash });
    }
  }

  // Single batched embedding call for everything that changed. Voyage's
  // limit is 128 inputs per request; current corpora are well under
  // that. We embed `embedding_text` — the heading-path-prefixed (or
  // overlap-prepended for sliding-window) version of the chunk — so the
  // dense vector captures section context that clean `content` alone
  // doesn't carry.
  let embeddings: number[][] = [];
  if (toEmbed.length > 0) {
    embeddings = (
      await embed(
        toEmbed.map((x) => x.chunk.embedding_text),
        'document',
      )
    ).vectors;
  }

  const rows: ChunkInput[] = toEmbed.map((x, i) => ({
    source: opts.source,
    source_id: opts.source_id,
    chunk_index: x.chunk.chunk_index,
    content: x.chunk.content,
    embedding: embeddings[i],
    embedding_text: x.chunk.embedding_text,
    metadata: { ...x.chunk.metadata },
    content_hash: x.hash,
  }));

  if (rows.length > 0) {
    const { error: upsertError } = await client
      .from('chunks')
      .upsert(rows, { onConflict: 'source,source_id,chunk_index' });
    if (upsertError) throw upsertError;
  }

  // Delete rows whose chunk_index no longer exists in the new corpus.
  // Covers the case where a section was removed from the source markdown.
  const newIndices = new Set(chunks.map((c) => c.chunk_index));
  const staleIndices: number[] = [];
  for (const idx of existing.keys()) {
    if (!newIndices.has(idx)) staleIndices.push(idx);
  }
  if (staleIndices.length > 0) {
    const { error: deleteError } = await client
      .from('chunks')
      .delete()
      .eq('source', opts.source)
      .eq('source_id', opts.source_id)
      .in('chunk_index', staleIndices);
    if (deleteError) throw deleteError;
  }

  const tokens_embedded = toEmbed.reduce(
    (sum, x) => sum + x.chunk.metadata.token_count,
    0,
  );

  return {
    total_chunks: chunks.length,
    created,
    updated,
    unchanged,
    tokens_embedded,
  };
}
