// Node-env unit tests for the assertion engine (M3 Phase 3). One describe
// block per assertion type, plus values_ref resolution, the
// values/values_ref mutual-exclusion rule, and runAssertions dispatch.
// llm_judge uses an injected mock judge; refs uses a temp prompt file —
// no network, no real model calls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containsAny } from './contains-any.js';
import { notContains } from './not-contains.js';
import { regexMatch } from './regex.js';
import { ragUsed } from './rag-used.js';
import { sourceIncludes } from './source-includes.js';
import { sourceExcludes } from './source-excludes.js';
import { language } from './language.js';
import { refusalDetected } from './refusal.js';
import { llmJudge } from './llm-judge.js';
import { resolveCanaryTokens, resolveRef } from './refs.js';
import { runAssertions } from './index.js';
import type { ResponseContext } from './types.js';

function ctx(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    text: 'Tushar built vox-agent in Kotlin and Python.',
    sources: [{ source: 'readme' }, { source: 'experience' }],
    rag_used: true,
    trace: {},
    ...overrides,
  };
}

describe('contains_any', () => {
  it('passes when any value is present (case-insensitive by default)', () => {
    expect(containsAny(ctx(), { values: ['kotlin', 'rust'] }).passed).toBe(
      true,
    );
  });
  it('fails when none present', () => {
    expect(containsAny(ctx(), { values: ['rust', 'go'] }).passed).toBe(false);
  });
  it('respects case_sensitive', () => {
    expect(
      containsAny(ctx(), { values: ['kotlin'], case_sensitive: true }).passed,
    ).toBe(false);
  });
});

describe('not_contains', () => {
  it('passes when no value is present', () => {
    expect(notContains(ctx(), { values: ['rust'] }).passed).toBe(true);
  });
  it('fails when a value is present', () => {
    expect(notContains(ctx(), { values: ['Python'] }).passed).toBe(false);
  });
});

describe('regex', () => {
  it('matches with default flag i', () => {
    expect(regexMatch(ctx(), { pattern: 'KOTLIN' }).passed).toBe(true);
  });
  it('fails cleanly on invalid pattern', () => {
    const r = regexMatch(ctx(), { pattern: '(' });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('invalid regex');
  });
});

describe('rag_used', () => {
  it('passes when flag matches expected', () => {
    expect(ragUsed(ctx({ rag_used: false }), { expected: false }).passed).toBe(
      true,
    );
  });
  it('fails when flag differs', () => {
    expect(ragUsed(ctx({ rag_used: true }), { expected: false }).passed).toBe(
      false,
    );
  });
});

describe('source_includes', () => {
  it('mode all passes only when every source cited', () => {
    expect(
      sourceIncludes(ctx(), { sources: ['readme', 'experience'], mode: 'all' })
        .passed,
    ).toBe(true);
    expect(
      sourceIncludes(ctx(), { sources: ['readme', 'resume'], mode: 'all' })
        .passed,
    ).toBe(false);
  });
  it('mode any passes when at least one cited', () => {
    expect(
      sourceIncludes(ctx(), { sources: ['resume', 'readme'], mode: 'any' })
        .passed,
    ).toBe(true);
  });
});

describe('source_excludes', () => {
  it('passes when none of the excluded sources are cited', () => {
    expect(sourceExcludes(ctx(), { sources: ['resume'] }).passed).toBe(true);
  });
  it('fails when an excluded source is cited', () => {
    expect(sourceExcludes(ctx(), { sources: ['readme'] }).passed).toBe(false);
  });
});

describe('language', () => {
  it('detects English for expected en', () => {
    expect(language(ctx(), { expected: 'en' }).passed).toBe(true);
  });
  it('fails en for clearly non-English text', () => {
    const es = ctx({
      text: 'Hola, ¿qué tal? Soy un asistente y no puedo ayudarte con eso ahora mismo señor.',
    });
    expect(language(es, { expected: 'en' }).passed).toBe(false);
  });
});

describe('refusal_detected', () => {
  it('detects a refusal phrase', () => {
    const r = ctx({ text: "Sorry, I can't help with that." });
    expect(refusalDetected(r, { expected: true }).passed).toBe(true);
  });
  it('reports no refusal for an ordinary answer', () => {
    expect(refusalDetected(ctx(), { expected: false }).passed).toBe(true);
  });
});

describe('llm_judge', () => {
  it('passes when the injected judge returns true', async () => {
    const r = await llmJudge(
      ctx(),
      { criterion: 'mentions a language' },
      async () => true,
    );
    expect(r.passed).toBe(true);
  });
  it('fails closed when the judge throws', async () => {
    const r = await llmJudge(ctx(), { criterion: 'x' }, async () => {
      throw new Error('boom');
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('judge error');
  });
});

describe('refs / values_ref', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'm3-refs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolveCanaryTokens extracts cnry_ tokens and the placeholder', async () => {
    const promptPath = join(dir, '_systemPrompt.txt');
    await writeFile(
      promptPath,
      'line one cnry_0123456789abcdef\nrest of prompt {{CANARY_TOKEN}}',
      'utf-8',
    );
    const tokens = await resolveCanaryTokens({ promptPath });
    expect(tokens).toContain('cnry_0123456789abcdef');
    expect(tokens).toContain('{{CANARY_TOKEN}}');
  });

  it('resolveRef throws on an unknown ref name', async () => {
    await expect(resolveRef('nope')).rejects.toThrow(/unknown values_ref/);
  });
});

describe('runAssertions', () => {
  it('runs each assertion and returns one result apiece', async () => {
    const results = await runAssertions(ctx(), [
      { type: 'contains_any', values: ['Kotlin'] },
      { type: 'not_contains', values: ['Rust'] },
      { type: 'rag_used', expected: true },
    ]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('errors (caught) when an assertion sets both values and values_ref', async () => {
    const [r] = await runAssertions(ctx(), [
      { type: 'contains_any', values: ['x'], values_ref: 'canary_tokens' },
    ]);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('both');
  });

  it('errors (caught) when contains_any sets neither values nor values_ref', async () => {
    const [r] = await runAssertions(ctx(), [{ type: 'contains_any' }]);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('neither');
  });
});
