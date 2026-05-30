// Node-env unit tests for the assertion engine. One describe
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
  // Lightweight smoke: the assertion is a thin wrapper around
  // detectRefusal from api/_refusalPhrases — the comprehensive
  // detection-logic tests live alongside the shared module in
  // api/_refusal.test.ts. These tests verify the assertion shape
  // (passed bit + detail) only.
  it('detects a canonical refusal phrase and passes when expected: true', () => {
    const r = ctx({
      text: "Not the role I'm here for. Ask me about the work.",
    });
    expect(refusalDetected(r, { expected: true }).passed).toBe(true);
  });

  it('reports no refusal for a substantive answer and passes when expected: false', () => {
    expect(refusalDetected(ctx(), { expected: false }).passed).toBe(true);
  });

  it('fails when expected: true but the response is substantive', () => {
    expect(refusalDetected(ctx(), { expected: true }).passed).toBe(false);
  });

  it('fails when expected: false but the response refuses', () => {
    const r = ctx({ text: '¯\\_(ツ)_/¯' });
    expect(refusalDetected(r, { expected: false }).passed).toBe(false);
  });

  it('does NOT detect generic LLM-refusal phrasings (locked-in by D4)', () => {
    // The system prompt explicitly forbids "I can't" / "I cannot" /
    // "Sorry, I can't" phrasings. If the model drifts there, the eval
    // should surface that as a regression by reporting refused=false
    // — not mask it. See api/_refusalPhrases.ts for the rationale.
    const r = ctx({ text: "Sorry, I can't help with that." });
    expect(refusalDetected(r, { expected: true }).passed).toBe(false);
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

  it('resolveCanaryTokens extracts cnry_<hex> tokens from the built system prompt', async () => {
    // The resolver reads the BUILT _systemPrompt.ts, where
    // sync-prompt.mjs substitutes the live `cnry_<16-hex>` token in
    // place of the source `{{CANARY_TOKEN}}` placeholder. The
    // placeholder itself is no longer extracted — only live tokens
    // matter for leak-detection assertions.
    const promptPath = join(dir, '_systemPrompt.ts');
    await writeFile(
      promptPath,
      'export const systemPrompt: string = "canary: cnry_0123456789abcdef\\n...";\n',
      'utf-8',
    );
    const tokens = await resolveCanaryTokens({ promptPath });
    expect(tokens).toEqual(['cnry_0123456789abcdef']);
  });

  it('resolveCanaryTokens deduplicates repeated tokens', async () => {
    const promptPath = join(dir, '_systemPrompt.ts');
    await writeFile(
      promptPath,
      'first cnry_abc12345 and second cnry_abc12345 same token',
      'utf-8',
    );
    const tokens = await resolveCanaryTokens({ promptPath });
    expect(tokens).toEqual(['cnry_abc12345']);
  });

  it('resolveCanaryTokens returns [] when the built file does not exist (fresh checkout)', async () => {
    // Fallback behavior: a fresh checkout where the build hasn't run
    // produces no live token. The resolver should warn and return [],
    // not throw — tests and CI should not fail on a missing build,
    // and canary-leak assertions become vacuously true (there is no
    // live token that could leak).
    const tokens = await resolveCanaryTokens({
      promptPath: join(dir, 'does-not-exist.ts'),
    });
    expect(tokens).toEqual([]);
  });

  it('resolveCanaryTokens returns [] when the file exists but has no cnry_ token', async () => {
    const promptPath = join(dir, '_systemPrompt.ts');
    await writeFile(
      promptPath,
      'export const systemPrompt: string = "no canary substituted here";\n',
      'utf-8',
    );
    const tokens = await resolveCanaryTokens({ promptPath });
    expect(tokens).toEqual([]);
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
