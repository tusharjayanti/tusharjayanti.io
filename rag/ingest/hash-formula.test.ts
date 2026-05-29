// Backward-compat proof for the README-aware hash formula. The
// previous formula hashed `content + '\n---embedding---\n' +
// embedding_text`. The current formula must:
//   - produce byte-identical hashes for non-readme sources (so
//     existing experience + resume rows already in DB don't re-embed)
//   - extend the input for readme sources with a summary_input_hash
//     suffix
//
// The spec's `'<none>'` sentinel mechanism would have produced
// different bytes for non-readme sources — we deviate by NOT appending
// the suffix at all when source !== 'readme'. Same operational
// outcome, mathematically valid.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { hashChunk, sha256Hex } from './markdown.js';
import type { MarkdownChunk } from '../chunking/markdown.js';

function legacyHash(content: string, embedding_text: string): string {
  return createHash('sha256')
    .update(`${content}\n---embedding---\n${embedding_text}`, 'utf-8')
    .digest('hex');
}

function makeChunk(content: string, embedding_text: string): MarkdownChunk {
  return {
    chunk_index: 0,
    content,
    embedding_text,
    metadata: { token_count: Math.ceil(content.length / 4) },
  };
}

describe('hashChunk — source-conditional', () => {
  it('matches the deployed formula byte-for-byte for source=experience', () => {
    const chunk = makeChunk(
      'DISCO body. ' + 'word '.repeat(50),
      'DISCO (Senior Software Engineer)\n## Identity platform migration\nDISCO body. ' +
        'word '.repeat(50),
    );
    const newHash = hashChunk(chunk, 'experience');
    const oldHash = legacyHash(chunk.content, chunk.embedding_text);
    expect(newHash).toBe(oldHash);
  });

  it('matches the deployed formula byte-for-byte for source=resume', () => {
    const chunk = makeChunk(
      'Resume body line.',
      'Summary\n## Senior engineer\nResume body line.',
    );
    expect(hashChunk(chunk, 'resume')).toBe(
      legacyHash(chunk.content, chunk.embedding_text),
    );
  });

  it('ignores the summaryInputHash argument for non-readme sources', () => {
    // Pass a non-empty summaryInputHash; non-readme must still hash to
    // the deployed value (otherwise existing rows re-embed).
    const chunk = makeChunk('body.', 'pref\nbody.');
    const without = hashChunk(chunk, 'experience');
    const withArg = hashChunk(chunk, 'experience', 'abc123');
    expect(without).toBe(withArg);
    expect(without).toBe(legacyHash(chunk.content, chunk.embedding_text));
  });

  it('extends the input for source=readme with the summary_input_hash', () => {
    const chunk = makeChunk(
      'readme body content.',
      'overlap from prev readme body content.',
    );
    const newHash = hashChunk(chunk, 'readme', 'sih-deadbeef');
    const expected = createHash('sha256')
      .update(
        `${chunk.content}\n---embedding---\n${chunk.embedding_text}\n---summary_input_hash---\nsih-deadbeef`,
        'utf-8',
      )
      .digest('hex');
    expect(newHash).toBe(expected);
  });

  it('produces different hashes for readme chunks with different neighbor contexts', () => {
    const chunk = makeChunk('body', 'overlap body');
    const a = hashChunk(chunk, 'readme', 'sih-one');
    const b = hashChunk(chunk, 'readme', 'sih-two');
    expect(a).not.toBe(b);
  });

  it('treats missing summaryInputHash on readme as empty string', () => {
    const chunk = makeChunk('body', 'overlap body');
    const withEmpty = hashChunk(chunk, 'readme', '');
    const withUndef = hashChunk(chunk, 'readme');
    expect(withEmpty).toBe(withUndef);
    // And both differ from any non-empty hash.
    const withReal = hashChunk(chunk, 'readme', 'sih-nonempty');
    expect(withEmpty).not.toBe(withReal);
  });
});

describe('sha256Hex', () => {
  it('produces the standard SHA-256 hex digest of UTF-8 input', () => {
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('is deterministic', () => {
    expect(sha256Hex('repeatable')).toBe(sha256Hex('repeatable'));
  });
});
