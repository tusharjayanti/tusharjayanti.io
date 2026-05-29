// Supabase client wrapper for chunks-table access. Server-side only —
// the secret key has bypass-RLS privilege and must never reach the browser
// bundle. Auth lifecycle is disabled (persistSession / autoRefreshToken
// off): Edge runtime has no persistent process and we authenticate every
// request with the secret key directly. Hybrid retrieval drops to .rpc()
// over raw SQL for the dense+sparse merge.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ChunkSource = 'docs' | 'experience' | 'readme' | 'resume';

// Mirrors the chunks table schema (supabase/migrations/0001_init_chunks.sql
// + 0005_chunks_embedding_text.sql). `tsv` is a generated tsvector column —
// server-maintained, present on reads if explicitly selected; typically
// used only for FTS index lookups. `embedding_text` is what was embedded
// into the dense vector — null for legacy rows ingested before the
// embedding-text column was added.
export type ChunkRow = {
  id: string;
  source: ChunkSource;
  source_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  embedding_text: string | null;
  tsv: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  created_at: string;
  updated_at: string;
};

// Fields supplied at upsert time. id is server-generated, tsv is a
// generated column, timestamps are defaulted by the schema.
export type ChunkInput = Pick<
  ChunkRow,
  | 'source'
  | 'source_id'
  | 'chunk_index'
  | 'content'
  | 'embedding'
  | 'embedding_text'
  | 'metadata'
  | 'content_hash'
>;

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set');
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set');
  _client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
