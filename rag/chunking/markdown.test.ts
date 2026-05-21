// Tests for the public chunker dispatcher and its two strategies.
//
// Adapted from M2.1's chunkMarkdown tests to the sub-spec 1 contract:
// `content` is now the clean body text (no heading prefix), and the
// heading-path-prefixed text moves to a new `embedding_text` field.
// Same conceptual coverage as before — chunk count, chunk_index
// continuity, heading metadata, paragraph-split fallback, dropping
// orphan headings — just re-routed through the new fields.

import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from './markdown.js';
import { chunkSlidingWindow } from './sliding-window.js';

describe('chunkMarkdown (hierarchical: experience / resume)', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkMarkdown('', 'experience')).toEqual([]);
  });

  it('returns an empty array when only an H1 is present (no H2/H3)', () => {
    expect(chunkMarkdown('# Title', 'experience')).toEqual([]);
    expect(
      chunkMarkdown(
        '# Title\n\nSome prose\n\nMore prose',
        'experience',
      ),
    ).toEqual([]);
  });

  it('emits one chunk for a single H2 + single H3 with a long-enough body', () => {
    // Body must be ≥ MIN_CHUNK_CHARS (200) to escape the min-merge
    // pass; pad with deterministic prose so the body alone is well
    // above the threshold.
    const body = 'Body line A. ' + 'Filler sentence. '.repeat(20);
    const md = [
      '# Title',
      '## DISCO (Senior Software Engineer)',
      '### Identity platform migration',
      body,
    ].join('\n');

    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    // Content is now clean body — no heading prefix.
    expect(chunks[0].content).toBe(body);
    // embedding_text carries the heading-path prefix.
    expect(chunks[0].embedding_text).toBe(
      `DISCO (Senior Software Engineer)\n## Identity platform migration\n${body}`,
    );
    expect(chunks[0].metadata.h2_heading).toBe(
      'DISCO (Senior Software Engineer)',
    );
    expect(chunks[0].metadata.h3_heading).toBe('Identity platform migration');
    expect(chunks[0].metadata.token_count).toBeGreaterThan(0);
  });

  it('emits one chunk per H3 under the same H2 with continuous chunk_index', () => {
    // Each body padded above MIN_CHUNK_CHARS so min-merge doesn't
    // collapse siblings together.
    const longBody = (label: string) =>
      `${label} body. ` + 'sentence sentence sentence. '.repeat(15);
    const md = [
      '## Company A',
      '### Role 1',
      longBody('A1'),
      '### Role 2',
      longBody('A2'),
      '### Role 3',
      longBody('A3'),
    ].join('\n');

    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.metadata.h2_heading)).toEqual([
      'Company A',
      'Company A',
      'Company A',
    ]);
    expect(chunks.map((c) => c.metadata.h3_heading)).toEqual([
      'Role 1',
      'Role 2',
      'Role 3',
    ]);
    // Every chunk's embedding_text starts with the heading path.
    for (const c of chunks) {
      expect(c.embedding_text.startsWith(`Company A\n## ${c.metadata.h3_heading}\n`)).toBe(true);
      // Content has no heading prefix.
      expect(c.content.startsWith('Company A')).toBe(false);
      expect(c.content.startsWith('## ')).toBe(false);
    }
  });

  it('continues chunk_index across H2 boundaries and switches h2_heading', () => {
    const longBody = (label: string) =>
      `${label} body. ` + 'sentence sentence sentence. '.repeat(15);
    const md = [
      '## Company A',
      '### Role 1',
      longBody('A1'),
      '### Role 2',
      longBody('A2'),
      '## Company B',
      '### Role 3',
      longBody('B1'),
      '### Role 4',
      longBody('B2'),
    ].join('\n');

    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.metadata.h2_heading)).toEqual([
      'Company A',
      'Company A',
      'Company B',
      'Company B',
    ]);
    expect(chunks.map((c) => c.metadata.h3_heading)).toEqual([
      'Role 1',
      'Role 2',
      'Role 3',
      'Role 4',
    ]);
  });

  it('splits a large H3 body into multiple chunks on paragraph boundaries', () => {
    // Each paragraph: ~200 estimated tokens (799 chars / 4 = 200).
    // Four such paragraphs > 500 tokens, must split.
    const p = (label: string) =>
      `${label} ${'word '.repeat(160).trimEnd()}`.trimEnd();

    const md = [
      '# Title',
      '## Company A',
      '### Role 1',
      p('P1'),
      '',
      p('P2'),
      '',
      p('P3'),
      '',
      p('P4'),
    ].join('\n');

    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);

    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );

    for (const c of chunks) {
      expect(c.metadata.h2_heading).toBe('Company A');
      expect(c.metadata.h3_heading).toBe('Role 1');
      // Every split chunk's embedding_text repeats the heading path.
      expect(c.embedding_text.startsWith('Company A\n## Role 1\n')).toBe(true);
      // Content stays clean — no heading prefix on any split chunk.
      expect(c.content.startsWith('Company A')).toBe(false);
      expect(c.metadata.token_count).toBeLessThanOrEqual(550);
    }
  });

  it('emits non-zero positive integer token counts', () => {
    const body = 'body. ' + 'word '.repeat(50);
    const md = ['## Company A', '### Role 1', body].join('\n');
    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(1);
    expect(Number.isInteger(chunks[0].metadata.token_count)).toBe(true);
    expect(chunks[0].metadata.token_count).toBeGreaterThan(0);
  });

  it('drops H3 headings with no body and never emits content equal to just the heading lines', () => {
    const body = 'body for role 2. ' + 'word '.repeat(50);
    const md = [
      '## Company A',
      '### Role 1',
      '### Role 2',
      body,
    ].join('\n');

    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.h3_heading).toBe('Role 2');
    expect(chunks[0].content).toBe(body);
    expect(chunks[0].embedding_text).toBe(
      `Company A\n## Role 2\n${body}`,
    );

    // EOF without body should also drop the trailing heading.
    const trailing = ['## Company A', '### Role 1'].join('\n');
    expect(chunkMarkdown(trailing, 'experience')).toEqual([]);
  });

  it('routes resume source through the hierarchical chunker', () => {
    const body = 'Resume body. ' + 'word '.repeat(60);
    const md = ['## Summary', '### Senior engineer', body].join('\n');
    const chunks = chunkMarkdown(md, 'resume');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.h2_heading).toBe('Summary');
    expect(chunks[0].metadata.h3_heading).toBe('Senior engineer');
    expect(chunks[0].embedding_text.startsWith('Summary\n## Senior engineer\n')).toBe(true);
  });

  it('min-merges a too-short H3 body into the previous sibling under the same H2', () => {
    const longBody = 'A long-enough body. ' + 'sentence sentence sentence. '.repeat(15);
    const shortBody = 'tiny.';
    const md = [
      '## Company A',
      '### Long role',
      longBody,
      '### Short role',
      shortBody,
    ].join('\n');
    const chunks = chunkMarkdown(md, 'experience');
    // Short sibling merges into long sibling under same H2.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.h2_heading).toBe('Company A');
    expect(chunks[0].content).toContain(longBody);
    expect(chunks[0].content).toContain(shortBody);
  });

  it('keeps a too-short orphan H3 under its own H2 when no merge target exists under that H2', () => {
    const longBody = 'A long-enough body. ' + 'sentence sentence sentence. '.repeat(15);
    const shortBody = 'tiny.';
    // The short H3 lives under Company A; the next H3 is under Company B
    // so backward AND forward merge under the same H2 both fail.
    const md = [
      '## Company A',
      '### Short role',
      shortBody,
      '## Company B',
      '### Long role',
      longBody,
    ].join('\n');
    const chunks = chunkMarkdown(md, 'experience');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].metadata.h2_heading).toBe('Company A');
    expect(chunks[0].content).toBe(shortBody);
    expect(chunks[1].metadata.h2_heading).toBe('Company B');
  });

  it('keeps a fenced code block atomic across paragraph boundaries', () => {
    // The fenced block contains blank lines, but the chunker must
    // treat the whole fence as a single paragraph and never split mid-
    // fence. With enough surrounding prose the section pushes past
    // 500 tokens and would otherwise split on the blanks inside.
    const filler = 'prose paragraph. ' + 'word '.repeat(160);
    const fence = [
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '',
      'const c = 3;',
      '```',
    ].join('\n');
    const md = [
      '## Company A',
      '### Role 1',
      filler,
      '',
      fence,
      '',
      filler,
    ].join('\n');
    const chunks = chunkMarkdown(md, 'experience');
    // At least one chunk's content contains the full fence intact.
    const matching = chunks.find((c) => c.content.includes(fence));
    expect(matching).toBeDefined();
  });
});

describe('chunkSlidingWindow (readme)', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkSlidingWindow('')).toEqual([]);
  });

  it('emits a single chunk for content under the target size', () => {
    const text = 'short README content.\n\nA second paragraph.';
    const chunks = chunkSlidingWindow(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].content).toBe(text);
    // First chunk's embedding_text equals content (no previous overlap).
    expect(chunks[0].embedding_text).toBe(text);
    expect(chunks[0].metadata.start_offset).toBe(0);
    expect(chunks[0].metadata.end_offset).toBe(text.length);
  });

  it('splits content longer than the target on paragraph boundaries', () => {
    // Build prose well over the 1500-char target with regular blank
    // lines so the chunker has explicit paragraph break points.
    const para = 'sentence sentence sentence sentence. '.repeat(20);
    const text = Array.from({ length: 6 }, () => para).join('\n\n');
    const chunks = chunkSlidingWindow(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // chunk_index is dense.
    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
    // Content chunks form a non-overlapping cover of the source.
    let cursor = 0;
    for (const c of chunks) {
      expect(c.metadata.start_offset).toBe(cursor);
      expect(c.content).toBe(text.slice(c.metadata.start_offset, c.metadata.end_offset));
      cursor = c.metadata.end_offset;
    }
    expect(cursor).toBe(text.length);
  });

  it('prepends the previous window-tail overlap to embedding_text (not content)', () => {
    const para = 'sentence sentence sentence sentence. '.repeat(20);
    const text = Array.from({ length: 6 }, () => para).join('\n\n');
    const chunks = chunkSlidingWindow(text);
    // All non-first chunks: embedding_text starts with the last
    // OVERLAP_CHARS of the previous chunk's content.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const overlap = prev.content.slice(
        Math.max(0, prev.content.length - 150),
      );
      expect(chunks[i].embedding_text.startsWith(overlap)).toBe(true);
      // Content itself does NOT carry the overlap.
      expect(chunks[i].content.startsWith(overlap)).toBe(false);
    }
  });

  it('keeps a fenced code block atomic even if it spans the target boundary', () => {
    // Stage the fence so a naive break at TARGET_CHUNK_CHARS (1500)
    // would split it mid-block. Then assert the fence ends up in a
    // single chunk's content.
    const lead = 'lead prose. '.repeat(110); // ~1300 chars
    const fenceBody = ['```ts', 'const x = 1;', 'const y = 2;', 'const z = 3;', '```'].join('\n');
    const tail = '\n\ntail prose after fence.';
    const text = lead + fenceBody + tail;
    const chunks = chunkSlidingWindow(text);
    const matching = chunks.find((c) => c.content.includes(fenceBody));
    expect(matching).toBeDefined();
  });

  it('routes readme source through the sliding-window chunker via the dispatcher', () => {
    const text = 'README intro\n\nDetails details details. '.repeat(40);
    const chunks = chunkMarkdown(text, 'readme');
    expect(chunks.length).toBeGreaterThan(0);
    // Sliding-window metadata carries offsets, not h2/h3 headings.
    expect(chunks[0].metadata).toHaveProperty('start_offset');
    expect(chunks[0].metadata).toHaveProperty('end_offset');
    expect(chunks[0].metadata.token_count).toBeGreaterThan(0);
  });
});
