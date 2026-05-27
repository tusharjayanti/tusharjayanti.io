// Assertion engine entry point (spec §8.3).
//
// runAssertions(response, assertions) evaluates every assertion against a
// ResponseContext and returns one AssertionResult per assertion. A query
// passes iff every assertion passes (the caller decides that).
//
// runAssertions is async because two paths require it: values_ref
// resolution reads a file (§6.3.2), and llm_judge calls a model. The
// per-type module functions in §8.3 are otherwise synchronous.

import { containsAny } from './contains-any.js';
import { language } from './language.js';
import { llmJudge } from './llm-judge.js';
import { notContains } from './not-contains.js';
import { ragUsed } from './rag-used.js';
import { refusalDetected } from './refusal.js';
import { regexMatch } from './regex.js';
import { resolveRef } from './refs.js';
import { sourceExcludes } from './source-excludes.js';
import { sourceIncludes } from './source-includes.js';
import type { Assertion, AssertionResult, ResponseContext } from './types.js';

export type {
  Assertion,
  AssertionResult,
  CitedSource,
  ResponseContext,
} from './types.js';

// Resolve the literal values for a value-bearing assertion. Exactly one
// of `values` / `values_ref` must be set (§6.3.2).
async function resolveValues(a: {
  values?: string[];
  values_ref?: string;
}): Promise<string[]> {
  if (a.values !== undefined && a.values_ref !== undefined) {
    throw new Error('assertion sets both `values` and `values_ref`; pick one');
  }
  if (a.values !== undefined) return a.values;
  if (a.values_ref !== undefined) return resolveRef(a.values_ref);
  throw new Error('assertion sets neither `values` nor `values_ref`');
}

async function runOne(
  response: ResponseContext,
  a: Assertion,
): Promise<AssertionResult> {
  switch (a.type) {
    case 'contains_any':
      return containsAny(response, {
        values: await resolveValues(a),
        case_sensitive: a.case_sensitive,
      });
    case 'not_contains':
      return notContains(response, {
        values: await resolveValues(a),
        case_sensitive: a.case_sensitive,
      });
    case 'regex':
      return regexMatch(response, a);
    case 'rag_used':
      return ragUsed(response, a);
    case 'source_includes':
      return sourceIncludes(response, a);
    case 'source_excludes':
      return sourceExcludes(response, a);
    case 'language':
      return language(response, a);
    case 'refusal_detected':
      return refusalDetected(response, a);
    case 'llm_judge':
      return llmJudge(response, a);
    default: {
      const unknown = a as { type?: string };
      return {
        type: unknown.type ?? 'unknown',
        passed: false,
        detail: `unknown assertion type "${unknown.type ?? ''}"`,
      };
    }
  }
}

export async function runAssertions(
  response: ResponseContext,
  assertions: Assertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of assertions) {
    try {
      results.push(await runOne(response, a));
    } catch (err) {
      results.push({
        type: (a as { type?: string }).type ?? 'unknown',
        passed: false,
        detail: `assertion error: ${(err as Error).message}`,
      });
    }
  }
  return results;
}
