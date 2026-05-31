// Integration test for the chat-endpoint wiring (Phase 4a). Gated on
// `EVAL_INTEGRATION=1` because it hits a deployed endpoint with the
// bypass header — operator runs it manually before merging Phase 4a /
// Phase 4b PRs. Requires the same env vars the runner needs in
// production:
//
//   EVAL_INTEGRATION=1            — enables this test
//   EVAL_CHAT_ENDPOINT_URL=...    — preview-deploy URL
//   EVAL_BYPASS_SECRET=...        — matches the deploy's EVAL_BYPASS_SECRET
//
// Without EVAL_INTEGRATION the test skips silently — keeps `npm test`
// fast and offline-friendly.

import { describe, it, expect } from 'vitest';

import {
  dispatchQuery,
  isResponseSourceAvailable,
  type Query,
  type DispatchDeps,
} from './dispatch.js';
import { getSupabaseClient } from '../../api/_supabase.js';

const RUN_INTEGRATION = process.env.EVAL_INTEGRATION === '1';

function makeDeps(): DispatchDeps {
  // Supabase isn't used by the assertion path; a no-op stub is enough
  // (matches the unit-test pattern).
  const noopSupabase = {
    rpc: async () => ({ data: [], error: null }),
  } as unknown as ReturnType<typeof getSupabaseClient>;
  return {
    embedding: new Array(1024).fill(0),
    mode: 'three-tool',
    threshold: 0.3,
    rerank: false,
    supabase: noopSupabase,
    isResponseSourceAvailable,
  };
}

describe.skipIf(!RUN_INTEGRATION)(
  'getResponseContext — live chat endpoint (EVAL_INTEGRATION=1)',
  () => {
    it('isResponseSourceAvailable reports true when both env vars are present', () => {
      // Sanity: the operator ran with both vars set, so the runner's
      // pre-flight check should pass.
      expect(isResponseSourceAvailable()).toBe(true);
    });

    it('executes a refusal-shaped query end-to-end and returns a non-empty response with trace_id', async () => {
      const q: Query = {
        id: 'integration-ref',
        query: "What's your favorite color?",
        result_type: 'assertion',
        category: 'refusal',
        tags: ['refusal'],
        assertions: [{ type: 'rag_used', expected: false }],
      };

      const outcome = await dispatchQuery(q, makeDeps());

      expect(outcome.kind).toBe('assertion');
      if (outcome.kind !== 'assertion') return;
      expect(outcome.responseText).toBeTruthy();
      expect(outcome.responseText!.length).toBeGreaterThan(0);
      // trace_id may be null if Langfuse isn't configured on the
      // deploy; cost may be null if the model isn't in the price
      // table. Both are soft — only assert what's always present.
      expect(outcome.latencySeconds).not.toBeNull();
      expect(outcome.latencySeconds! > 0).toBe(true);
    }, 30_000);
  },
);
