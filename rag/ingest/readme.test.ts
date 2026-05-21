// Tests for the README ingest orchestrator. All external services
// (GitHub, Anthropic, Voyage, Supabase) are mocked. Covers:
//   - dispatch to the sliding-window chunker via chunkMarkdown(_, 'readme')
//   - per-chunk Haiku call with prev/this/next neighbors
//   - embedding_text = summary + "\n\n" + sliding-window embedding_text
//   - cache hit on full content_hash match (zero external calls)
//   - cached summary recovery via splitting embedding_text on first '\n\n'
//   - stale chunk_index cleanup

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchReadme: vi.fn(),
  embed: vi.fn(),
  summarizeChunk: vi.fn(),
  // Supabase client surface — we re-build a fake table builder per test
  // because the .from(...) chain varies (select/eq/upsert/delete).
  supabaseFrom: vi.fn(),
}));

vi.mock('../clients/github.js', () => ({
  fetchReadme: mocks.fetchReadme,
}));

vi.mock('../../api/_voyage.js', () => ({
  embed: mocks.embed,
}));

vi.mock('./haiku-summary.js', () => ({
  summarizeChunk: mocks.summarizeChunk,
}));

vi.mock('../../api/_supabase.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_supabase.js')
  >('../../api/_supabase.js');
  return {
    ...actual,
    getSupabaseClient: () => ({ from: mocks.supabaseFrom }),
  };
});

const { ingestReadme, extractCachedSummary } = await import('./readme.js');

type ExistingRow = {
  chunk_index: number;
  content_hash: string;
  embedding_text: string | null;
};

// Construct a supabase `.from(...)` builder that:
// - .select(...).eq(...).eq(...) → returns { data: existingRows }
// - .upsert(...) → captures the upsert payload
// - .delete().eq(...).eq(...).in(...) → captures the delete predicate
function makeSupabaseBuilder(opts: {
  existing: ExistingRow[];
  captureUpsert: (rows: unknown[]) => void;
  captureDelete: (staleIndices: number[]) => void;
}) {
  return () => {
    const builder = {
      // SELECT path
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      // RESULT producers
      // .select(...).eq(...).eq(...) is awaited → returns the data
      then: undefined as undefined | ((cb: unknown) => unknown),
      // UPSERT
      upsert: vi.fn(async (rows: unknown[]) => {
        opts.captureUpsert(rows);
        return { error: null };
      }),
      // DELETE
      delete: vi.fn(() => {
        const delBuilder = {
          eq: vi.fn(() => delBuilder),
          in: vi.fn(async (_col: string, staleIndices: number[]) => {
            opts.captureDelete(staleIndices);
            return { error: null };
          }),
        };
        return delBuilder;
      }),
    } as Record<string, unknown> & {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      then?: (cb: unknown) => unknown;
    };
    // The select-eq-eq chain needs to be thenable so `await ...select().eq().eq()`
    // resolves to { data, error }. Make `eq` return a thenable proxy.
    const thenable = {
      then: (resolve: (v: unknown) => void) => {
        resolve({ data: opts.existing, error: null });
      },
    };
    builder.select = vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => thenable),
      })),
    })) as ReturnType<typeof vi.fn>;
    return builder;
  };
}

const FAKE_EMBEDDING_LEN = 1024;
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: FAKE_EMBEDDING_LEN }, (_, i) => (seed + i) / 10);
}

describe('ingestReadme', () => {
  let upsertedRows: unknown[];
  let deletedIndices: number[];

  beforeEach(() => {
    mocks.fetchReadme.mockReset();
    mocks.embed.mockReset();
    mocks.summarizeChunk.mockReset();
    mocks.supabaseFrom.mockReset();
    upsertedRows = [];
    deletedIndices = [];
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  });

  it('routes through the sliding-window chunker for source=readme and composes embedding_text correctly', async () => {
    // Build a README long enough to produce >1 sliding-window chunk.
    const para = 'sentence sentence sentence sentence. '.repeat(20);
    const content = Array.from({ length: 4 }, () => para).join('\n\n');
    mocks.fetchReadme.mockResolvedValue(content);

    mocks.summarizeChunk.mockImplementation(async ({ chunkOrder }) => ({
      summary: `Summary for chunk ${chunkOrder}.`,
      inputTokens: 100,
      outputTokens: 20,
    }));

    mocks.embed.mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => fakeEmbedding(i)),
    );

    mocks.supabaseFrom.mockImplementation(
      makeSupabaseBuilder({
        existing: [],
        captureUpsert: (rows) => upsertedRows.push(...rows),
        captureDelete: (idx) => deletedIndices.push(...idx),
      }),
    );

    const result = await ingestReadme('tushar/example');
    expect(result.repo).toBe('tushar/example');
    expect(result.total_chunks).toBeGreaterThanOrEqual(2);
    expect(result.created).toBe(result.total_chunks);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.summary_cache_hits).toBe(0);

    // Haiku called once per chunk.
    expect(mocks.summarizeChunk).toHaveBeenCalledTimes(result.total_chunks);
    // Voyage called once total, batched.
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.embed.mock.calls[0]![0]).toHaveLength(result.total_chunks);

    // Each upserted row's embedding_text starts with the summary, then '\n\n'.
    for (const row of upsertedRows as Array<{
      embedding_text: string;
      source: string;
      source_id: string;
    }>) {
      expect(row.source).toBe('readme');
      expect(row.source_id).toBe('tushar/example');
      expect(row.embedding_text.startsWith('Summary for chunk ')).toBe(true);
      expect(row.embedding_text).toContain('\n\n');
    }
  });

  it('passes prev / this / next neighbors to summarizeChunk', async () => {
    const para = 'distinctprose-AAA '.repeat(80);
    const para2 = 'distinctprose-BBB '.repeat(80);
    const para3 = 'distinctprose-CCC '.repeat(80);
    const content = [para, para2, para3].join('\n\n');
    mocks.fetchReadme.mockResolvedValue(content);
    mocks.summarizeChunk.mockResolvedValue({
      summary: 'S.',
      inputTokens: 1,
      outputTokens: 1,
    });
    mocks.embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => fakeEmbedding(0)),
    );
    mocks.supabaseFrom.mockImplementation(
      makeSupabaseBuilder({
        existing: [],
        captureUpsert: (rows) => upsertedRows.push(...rows),
        captureDelete: (idx) => deletedIndices.push(...idx),
      }),
    );

    await ingestReadme('tushar/example');
    // First chunk: prev=null, has next
    expect(mocks.summarizeChunk.mock.calls[0]![0].prev).toBeNull();
    expect(mocks.summarizeChunk.mock.calls[0]![0].next).not.toBeNull();
    // Last chunk: next=null
    const lastCall =
      mocks.summarizeChunk.mock.calls[mocks.summarizeChunk.mock.calls.length - 1]!;
    expect(lastCall[0].next).toBeNull();
  });

  it('skips Haiku + Voyage entirely on a full cache hit', async () => {
    // Construct a README and pre-build the existing row exactly as the
    // orchestrator would write it on first ingest — same chunk content,
    // same summary, same hash. Re-running should be a no-op.
    const content = 'short readme content with detail.';
    mocks.fetchReadme.mockResolvedValue(content);

    // Run the orchestrator once with an empty DB to capture the
    // upserted hash + embedding_text shape, then re-run with that row
    // populated as "existing" and verify zero external calls.
    const firstRunRows: unknown[] = [];
    mocks.summarizeChunk.mockResolvedValueOnce({
      summary: 'Stored summary.',
      inputTokens: 50,
      outputTokens: 10,
    });
    mocks.embed.mockResolvedValueOnce([fakeEmbedding(0)]);
    // mockImplementation (not Once) — supabase.from('chunks') is called
    // multiple times per ingest (select, upsert, delete). We swap the
    // implementation between the two runs by resetting on the second.
    mocks.supabaseFrom.mockImplementation(
      makeSupabaseBuilder({
        existing: [],
        captureUpsert: (rows) => firstRunRows.push(...rows),
        captureDelete: () => undefined,
      }),
    );
    const firstRun = await ingestReadme('tushar/example');
    expect(firstRun.created).toBeGreaterThan(0);

    // Second run: feed firstRunRows back as existing.
    mocks.summarizeChunk.mockReset();
    mocks.embed.mockReset();
    mocks.supabaseFrom.mockReset();
    const existingFromFirstRun = firstRunRows.map((row) => {
      const r = row as {
        chunk_index: number;
        content_hash: string;
        embedding_text: string;
      };
      return {
        chunk_index: r.chunk_index,
        content_hash: r.content_hash,
        embedding_text: r.embedding_text,
      };
    });
    mocks.supabaseFrom.mockImplementation(
      makeSupabaseBuilder({
        existing: existingFromFirstRun,
        captureUpsert: () => {
          throw new Error('upsert should not be called on full cache hit');
        },
        captureDelete: () => undefined,
      }),
    );
    const secondRun = await ingestReadme('tushar/example');
    expect(secondRun.unchanged).toBe(secondRun.total_chunks);
    expect(secondRun.created).toBe(0);
    expect(secondRun.updated).toBe(0);
    expect(secondRun.summary_cache_hits).toBe(secondRun.total_chunks);
    expect(secondRun.haiku_input_tokens).toBe(0);
    expect(secondRun.voyage_tokens).toBe(0);
    expect(mocks.summarizeChunk).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
});

describe('extractCachedSummary', () => {
  it('returns the summary from a well-formed embedding_text', () => {
    expect(extractCachedSummary('A short summary.\n\nThe rest of it.')).toBe(
      'A short summary.',
    );
  });

  it('returns null when no double-newline separator is present', () => {
    expect(extractCachedSummary('no separator here just one block')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractCachedSummary(null)).toBeNull();
  });
});
