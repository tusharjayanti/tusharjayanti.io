// rag_used (§6.3) — whether RAG (any search_* tool) was invoked for the
// turn. Used by off-topic queries to assert RAG was skipped.

import type { AssertionResult, ResponseContext } from './types.js';

export function ragUsed(
  response: ResponseContext,
  params: { expected: boolean },
): AssertionResult {
  const ok = response.rag_used === params.expected;
  return {
    type: 'rag_used',
    passed: ok,
    detail: `rag_used=${response.rag_used}, expected=${params.expected}`,
  };
}
