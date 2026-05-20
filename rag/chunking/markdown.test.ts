import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from './markdown.js';

describe('chunkMarkdown', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });

  it('returns an empty array when only an H1 is present (no H2/H3)', () => {
    expect(chunkMarkdown('# Title')).toEqual([]);
    expect(chunkMarkdown('# Title\n\nSome prose\n\nMore prose')).toEqual([]);
  });

  it('emits one chunk for a single H2 + single H3 with a short body', () => {
    const md = [
      '# Title',
      '## DISCO (Senior Software Engineer)',
      '### Identity platform migration',
      'Body line 1',
      'Body line 2',
    ].join('\n');

    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].content).toBe(
      'DISCO (Senior Software Engineer)\n## Identity platform migration\nBody line 1\nBody line 2',
    );
    expect(chunks[0].metadata.h2_heading).toBe(
      'DISCO (Senior Software Engineer)',
    );
    expect(chunks[0].metadata.h3_heading).toBe('Identity platform migration');
    expect(chunks[0].metadata.token_count).toBeGreaterThan(0);
  });

  it('emits one chunk per H3 under the same H2 with continuous chunk_index', () => {
    const md = [
      '## Company A',
      '### Role 1',
      'body A1',
      '### Role 2',
      'body A2',
      '### Role 3',
      'body A3',
    ].join('\n');

    const chunks = chunkMarkdown(md);
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
  });

  it('continues chunk_index across H2 boundaries and switches h2_heading', () => {
    const md = [
      '## Company A',
      '### Role 1',
      'body A1',
      '### Role 2',
      'body A2',
      '## Company B',
      '### Role 3',
      'body B1',
      '### Role 4',
      'body B2',
    ].join('\n');

    const chunks = chunkMarkdown(md);
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
    // Four such paragraphs + H2 + H3 prefix > 500 tokens, must split.
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

    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);

    expect(chunks.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );

    for (const c of chunks) {
      expect(c.metadata.h2_heading).toBe('Company A');
      expect(c.metadata.h3_heading).toBe('Role 1');
      // Every split chunk repeats the H2 + H3 prefix.
      expect(c.content.startsWith('Company A\n## Role 1\n')).toBe(true);
      expect(c.metadata.token_count).toBeLessThanOrEqual(550);
    }
  });

  it('emits non-zero positive integer token counts', () => {
    const md = ['## Company A', '### Role 1', 'body'].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(Number.isInteger(chunks[0].metadata.token_count)).toBe(true);
    expect(chunks[0].metadata.token_count).toBeGreaterThan(0);
  });

  it('drops H3 headings with no body and never emits content equal to just the heading lines', () => {
    const md = [
      '## Company A',
      '### Role 1',
      '### Role 2',
      'body for role 2',
    ].join('\n');

    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.h3_heading).toBe('Role 2');
    expect(chunks[0].content).toBe('Company A\n## Role 2\nbody for role 2');

    // EOF without body should also drop the trailing heading.
    const trailing = ['## Company A', '### Role 1'].join('\n');
    expect(chunkMarkdown(trailing)).toEqual([]);
  });
});
