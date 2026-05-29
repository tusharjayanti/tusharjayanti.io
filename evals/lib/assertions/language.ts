// language — response is in the expected BCP-47 language.
//
// Robust language detection needs a dependency. The portfolio is
// English-only and no `language` assertions are authored yet, so this
// uses a common-English-stopword-ratio heuristic that reliably
// separates English from non-English for the `expected: "en"` case.
// Escalate to a detection library if non-English assertions are
// introduced.

import type { AssertionResult, ResponseContext } from './types.js';

const EN_STOPWORDS = new Set([
  'the',
  'and',
  'is',
  'are',
  'to',
  'of',
  'a',
  'in',
  'that',
  'it',
  'for',
  'on',
  'with',
  'as',
  'was',
  'at',
  'this',
  'has',
  'have',
  'or',
  'an',
  'be',
  'by',
  'from',
  'his',
  'her',
  'they',
  'i',
  'you',
]);

const EN_RATIO_THRESHOLD = 0.1;

export function language(
  response: ResponseContext,
  params: { expected: string },
): AssertionResult {
  const words = response.text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const enHits = words.filter((w) => EN_STOPWORDS.has(w)).length;
  const ratio = words.length === 0 ? 0 : enHits / words.length;
  const looksEnglish = ratio >= EN_RATIO_THRESHOLD;
  const expectsEnglish = params.expected.toLowerCase().startsWith('en');
  const ok = expectsEnglish ? looksEnglish : !looksEnglish;
  return {
    type: 'language',
    passed: ok,
    detail: `expected=${params.expected}; en-stopword-ratio=${ratio.toFixed(2)} (heuristic)`,
  };
}
