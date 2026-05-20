// Generic markdown-source ingest pipeline used by every markdown-backed
// RAG corpus (experience.md in M2.1, resume.md in M2.3, READMEs in M2.5).
// Reads the file from disk, chunks via the shared markdown chunker, diffs
// against existing rows in `chunks` (matched by source/source_id/
// chunk_index), embeds only the rows that are new or whose content_hash
// changed, upserts via the (source, source_id, chunk_index) unique key,
// and deletes any rows whose chunk_index no longer appears in the new
// chunk set (covers the "section deleted from the corpus" case). File
// paths are resolved against process.cwd() so callers stay agnostic to
// where the script lives.

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
  source: string;
  source_id: string;
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export async function ingestMarkdownSource(
  opts: IngestOptions,
): Promise<IngestResult> {
  const resolvedPath = resolve(process.cwd(), opts.filePath);
  const markdown = await readFile(resolvedPath, 'utf-8');
  const chunks = chunkMarkdown(markdown);

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
    const hash = sha256Hex(chunk.content);
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
  // limit is 128 inputs per request; current corpora are well under that.
  let embeddings: number[][] = [];
  if (toEmbed.length > 0) {
    embeddings = await embed(
      toEmbed.map((x) => x.chunk.content),
      'document',
    );
  }

  // `source` is widened to `string` at the IngestOptions boundary so M2.5
  // README ingest can supply repo-derived strings without TS friction. The
  // DB-level check constraint in 0001_init_chunks.sql is the actual
  // enforcement: a bad source value fails the upsert.
  const rows: ChunkInput[] = toEmbed.map((x, i) => ({
    source: opts.source as ChunkSource,
    source_id: opts.source_id,
    chunk_index: x.chunk.chunk_index,
    content: x.chunk.content,
    embedding: embeddings[i],
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
