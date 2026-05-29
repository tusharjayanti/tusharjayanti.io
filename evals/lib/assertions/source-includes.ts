// source_includes — cited sources include all/any of the listed
// source names. Used by multi-facet queries (mode "all") to assert every
// expected facet's source was retrieved.

import type { AssertionResult, ResponseContext } from './types.js';

export function sourceIncludes(
  response: ResponseContext,
  params: { sources: string[]; mode: 'all' | 'any' },
): AssertionResult {
  const cited = new Set(response.sources.map((s) => s.source));
  const present = params.sources.filter((s) => cited.has(s));
  const ok =
    params.mode === 'all'
      ? present.length === params.sources.length
      : present.length > 0;
  return {
    type: 'source_includes',
    passed: ok,
    detail: `mode=${params.mode}; cited=[${[...cited].join(', ')}]; required=[${params.sources.join(', ')}]`,
  };
}
