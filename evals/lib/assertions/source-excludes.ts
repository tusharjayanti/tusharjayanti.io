// source_excludes (§6.3) — none of the listed sources are cited.

import type { AssertionResult, ResponseContext } from './types.js';

export function sourceExcludes(
  response: ResponseContext,
  params: { sources: string[] },
): AssertionResult {
  const cited = new Set(response.sources.map((s) => s.source));
  const violating = params.sources.filter((s) => cited.has(s));
  return {
    type: 'source_excludes',
    passed: violating.length === 0,
    detail:
      violating.length === 0
        ? `none of [${params.sources.join(', ')}] cited`
        : `cited excluded source(s): [${violating.join(', ')}]`,
  };
}
