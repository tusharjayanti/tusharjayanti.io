// contains_any (§6.3) — response text contains at least one of the
// listed strings. `values` are pre-resolved by the engine (values_ref is
// resolved to concrete strings in index.ts before this runs).

import type { AssertionResult, ResponseContext } from './types.js';

export function containsAny(
  response: ResponseContext,
  params: { values: string[]; case_sensitive?: boolean },
): AssertionResult {
  const caseSensitive = params.case_sensitive ?? false;
  const haystack = caseSensitive ? response.text : response.text.toLowerCase();
  const matched = params.values.find((v) =>
    haystack.includes(caseSensitive ? v : v.toLowerCase()),
  );
  return {
    type: 'contains_any',
    passed: matched !== undefined,
    detail:
      matched !== undefined
        ? `matched "${matched}"`
        : `none of ${params.values.length} value(s) present`,
  };
}
