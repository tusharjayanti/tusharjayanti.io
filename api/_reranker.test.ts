// Unit tests for the Haiku reranker. The Anthropic SDK is never
// hit — all reranker calls inject a fake `judge` via RerankOpts.
// Tests verify the cosine pre-filter, the skip-condition, the
// seeded-shuffle determinism, verdict parsing, diversification,
// and the graceful fallback path on judge failure.

import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_COSINE_PRE_FILTER,
  diversifyByPass,
  parseRerankerOutput,
  rerankChunks,
  seedFromQuery,
  seededShuffle,
  type RerankerCandidate,
} from './_reranker.js';

function chunk(
  source_id: string,
  chunk_index: number,
  cosineSim = 0.8,
  content?: string,
): RerankerCandidate & { score: number } {
  return {
    source_id,
    chunk_index,
    content: content ?? `${source_id} chunk ${chunk_index}`,
    semantic_distance: 1 - cosineSim,
    score: 0.0164,
  };
}

describe('parseRerankerOutput', () => {
  it('parses a well-formed comma-separated list', () => {
    const m = parseRerankerOutput('1:yes, 2:no, 3:yes', [1, 2, 3]);
    expect(m.get(1)).toBe('yes');
    expect(m.get(2)).toBe('no');
    expect(m.get(3)).toBe('yes');
  });

  it('tolerates extra whitespace, brackets, and trailing commas', () => {
    const m = parseRerankerOutput('  [1]:yes,    2:NO , [3]:Yes,', [1, 2, 3]);
    expect(m.get(1)).toBe('yes');
    expect(m.get(2)).toBe('no');
    expect(m.get(3)).toBe('yes');
  });

  it('treats malformed pairs as "no" (default for the id)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = parseRerankerOutput('1:yes, garbage, 3:yes', [1, 2, 3]);
    expect(m.get(1)).toBe('yes');
    expect(m.get(2)).toBe('no'); // never appeared → default no
    expect(m.get(3)).toBe('yes');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats ids missing from the output as "no"', () => {
    const m = parseRerankerOutput('1:yes, 5:yes', [1, 2, 3, 4, 5]);
    expect(m.get(1)).toBe('yes');
    expect(m.get(2)).toBe('no');
    expect(m.get(3)).toBe('no');
    expect(m.get(4)).toBe('no');
    expect(m.get(5)).toBe('yes');
  });

  it('ignores verdicts for ids that were never sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = parseRerankerOutput('1:yes, 99:yes', [1, 2]);
    expect(m.get(1)).toBe('yes');
    expect(m.get(2)).toBe('no');
    expect(m.has(99)).toBe(false);
    warn.mockRestore();
  });
});

describe('seedFromQuery', () => {
  it('returns the same seed for the same query', async () => {
    const a = await seedFromQuery('vox-agent hallucination');
    const b = await seedFromQuery('vox-agent hallucination');
    expect(a).toBe(b);
  });

  it('returns different seeds for different queries', async () => {
    const a = await seedFromQuery('Rust experience');
    const b = await seedFromQuery('Rust experiance');
    const c = await seedFromQuery('How does shortlist work');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});

describe('seededShuffle', () => {
  it('is deterministic given the same seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = seededShuffle(items, 12345);
    const b = seededShuffle(items, 12345);
    expect(a).toEqual(b);
  });

  it('produces a different order for a different seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = seededShuffle(items, 1);
    const b = seededShuffle(items, 2);
    expect(a).not.toEqual(b);
    const numericSort = (x: number[]) => x.slice().sort((p, q) => p - q);
    expect(numericSort(a)).toEqual(items);
    expect(numericSort(b)).toEqual(items);
  });
});

describe('diversifyByPass', () => {
  it('picks one chunk per distinct source_id first, then fills the rest', () => {
    const a1 = chunk('a', 1);
    const a2 = chunk('a', 2);
    const b1 = chunk('b', 1);
    const c1 = chunk('c', 1);
    const out = diversifyByPass([a1, a2, b1, c1], 4);
    // Pass 1: a1, b1, c1 (one each of a/b/c). Pass 2: a2.
    expect(out).toEqual([a1, b1, c1, a2]);
  });

  it('returns at most N chunks', () => {
    const items = [
      chunk('a', 1),
      chunk('a', 2),
      chunk('a', 3),
      chunk('b', 1),
      chunk('c', 1),
    ];
    expect(diversifyByPass(items, 2)).toHaveLength(2);
  });
});

describe('rerankChunks', () => {
  it('drops chunks below the cosine pre-filter (default 0.15)', async () => {
    const survivor = chunk('a', 1, 0.8);
    const dropped = chunk('b', 1, 0.05); // cos sim 0.05 < 0.15
    const out = await rerankChunks('q', [survivor, dropped], {
      judge: async () => '1:yes',
    });
    // Only survivor reached either Haiku or skip-condition diversify
    expect(out).toEqual([survivor]);
  });

  it('skips Haiku when ≤3 candidates survive the pre-filter', async () => {
    const judge = vi.fn(async () => '1:no, 2:no, 3:no');
    const items = [chunk('a', 1), chunk('b', 1), chunk('c', 1)];
    const out = await rerankChunks('q', items, { judge });
    // Below the skip threshold → judge never called
    expect(judge).not.toHaveBeenCalled();
    expect(out).toEqual([items[0], items[1], items[2]]);
  });

  it('calls Haiku and drops "no" verdicts when >3 candidates survive', async () => {
    const items = [
      chunk('a', 1, 0.8),
      chunk('a', 2, 0.8),
      chunk('b', 1, 0.8),
      chunk('c', 1, 0.8),
      chunk('d', 1, 0.8),
    ];
    // The reranker assigns ids 1..5 by pre-filter order BEFORE
    // shuffling. Verdicts: 1=yes (a/1), 2=no (a/2), 3=yes (b/1),
    // 4=no (c/1), 5=yes (d/1) → 3 survivors.
    const judge = vi.fn(async () => '1:yes, 2:no, 3:yes, 4:no, 5:yes');
    const out = await rerankChunks('q', items, { judge, topN: 5 });
    expect(judge).toHaveBeenCalledOnce();
    const survivorIds = out.map((c) => `${c.source_id}/${c.chunk_index}`);
    expect(survivorIds).toContain('a/1');
    expect(survivorIds).toContain('b/1');
    expect(survivorIds).toContain('d/1');
    expect(survivorIds).not.toContain('a/2');
    expect(survivorIds).not.toContain('c/1');
  });

  it('returns an empty array when Haiku marks every candidate "no"', async () => {
    const items = [
      chunk('a', 1, 0.8),
      chunk('a', 2, 0.8),
      chunk('b', 1, 0.8),
      chunk('c', 1, 0.8),
    ];
    const out = await rerankChunks('q', items, {
      judge: async () => '1:no, 2:no, 3:no, 4:no',
    });
    expect(out).toEqual([]);
  });

  it('falls back to the pre-filter top-N when the judge throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items = [
      chunk('a', 1, 0.8),
      chunk('a', 2, 0.8),
      chunk('b', 1, 0.8),
      chunk('c', 1, 0.8),
      chunk('d', 1, 0.8),
      chunk('e', 1, 0.8),
    ];
    const out = await rerankChunks('q', items, {
      topN: 3,
      judge: async () => {
        throw new Error('haiku 5xx');
      },
    });
    // Fallback: top-3 from the pre-filter list, diversified. All
    // unique sources → first 3 in input order.
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.source_id)).toEqual(['a', 'b', 'c']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('diversifies the survivors so one chunk per source comes first', async () => {
    // Four candidates from source "a", one from "b". Even though
    // Haiku says all yes, diversification should put "b" before
    // a/2, a/3, a/4 in the top-N.
    const items = [
      chunk('a', 1, 0.8),
      chunk('a', 2, 0.8),
      chunk('a', 3, 0.8),
      chunk('a', 4, 0.8),
      chunk('b', 1, 0.8),
    ];
    const out = await rerankChunks('q', items, {
      topN: 3,
      judge: async () => '1:yes, 2:yes, 3:yes, 4:yes, 5:yes',
    });
    expect(out.map((c) => `${c.source_id}/${c.chunk_index}`)).toEqual([
      'a/1',
      'b/1',
      'a/2',
    ]);
  });

  it('returns nothing when every chunk fails the cosine pre-filter', async () => {
    const judge = vi.fn();
    const items = [chunk('a', 1, 0.05), chunk('b', 1, 0.1)];
    const out = await rerankChunks('q', items, { judge });
    expect(out).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('config defaults', () => {
  it('exposes a pre-filter default of 0.15 (was 0.3 pre-M2.7)', () => {
    expect(DEFAULT_COSINE_PRE_FILTER).toBe(0.15);
  });
});
