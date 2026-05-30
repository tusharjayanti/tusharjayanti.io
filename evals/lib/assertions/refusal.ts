// refusal_detected — wraps the shared canonical detector in
// api/_refusalPhrases.ts so the eval surface and the production
// trace tagger stay aligned. See _refusalPhrases.ts for the phrase
// list and the design rationale (literal substring + word-count
// guard, no generic LLM-refusal regex fallback — if the model
// drifts off-style, that drift is the regression).

import { detectRefusal } from '../../../api/_refusalPhrases.js';
import type { AssertionResult, ResponseContext } from './types.js';

export function refusalDetected(
  response: ResponseContext,
  params: { expected: boolean },
): AssertionResult {
  const refused = detectRefusal(response.text);
  const ok = refused === params.expected;
  return {
    type: 'refusal_detected',
    passed: ok,
    detail: `refusal ${refused ? 'detected' : 'not detected'}, expected ${params.expected}`,
  };
}
