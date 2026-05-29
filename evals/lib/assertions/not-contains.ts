// not_contains — response text contains none of the listed
// strings. `values` are pre-resolved by the engine (values_ref handled in
// index.ts). Used by canary-leak / refusal categories to assert sensitive
// substrings are absent.

import type { AssertionResult, ResponseContext } from './types.js';

export function notContains(
  response: ResponseContext,
  params: { values: string[]; case_sensitive?: boolean },
): AssertionResult {
  const caseSensitive = params.case_sensitive ?? false;
  const haystack = caseSensitive ? response.text : response.text.toLowerCase();
  const hit = params.values.find((v) =>
    haystack.includes(caseSensitive ? v : v.toLowerCase()),
  );
  return {
    type: 'not_contains',
    passed: hit === undefined,
    detail:
      hit === undefined
        ? `none of ${params.values.length} value(s) present`
        : `response contained "${hit}"`,
  };
}
