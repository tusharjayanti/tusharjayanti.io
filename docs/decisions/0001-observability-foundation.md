# ADR 0001 — Observability foundation: Langfuse over hand-rolled Redis log

- **Status:** Accepted (M1, May 2026)
- **Deciders:** Tushar
- **Supersedes:** N/A (first ADR)

## Context

By the end of Phase 0.2, every chat turn was being written to Upstash
Redis with a hand-rolled JSON envelope containing ipHash, q, aPreview,
token counts (input/output/cache-creation/cache-read), model, and
latency. The log was already populated by `logChatTurn` on each
turn, with an analogous error log on the spike-alert path. A daily
digest cron summarized the previous day and emailed it via Resend.

That setup answered "what happened today?" well enough. It did not
answer:

- "Cost per prompt version, comparing version N to version N+1."
- "Tag-filtered cost distribution — how much am I spending on
  refusals?"
- "Latency p50/p95 over the last 30 days, split by whether the prompt
  was cache-hit or cache-miss."
- "Which trace had the highest TTFT yesterday, and what was the
  input?"

Each one would require either a custom Redis query layer or
re-shaping the schema. Building that on top of Redis lists felt
like reinventing the kind of observability platform LLMOps tooling
already exists for.

The portfolio is also explicitly positioned as an LLMOps testbed.
The Langfuse trace structure is industry-standard vocabulary
(trace/generation/span/score). Putting it in the README and being
able to talk about it in interviews is itself signal — more so than
a more elaborate hand-rolled solution that nobody outside the repo
would recognize.

## Decision drivers

- **Queryability** of structured observability data without
  building a query layer.
- **Industry-standard vocabulary** — trace, generation, tag, score,
  prompt — that an interviewer recognizes.
- **Cost computation** that handles prompt-cache buckets correctly
  out of the box.
- **Prompt versioning** as a first-class concept tied to traces.
- **Edge runtime compatibility** — the chat handler runs on Vercel
  Edge, so the client must use `fetch` rather than Node-specific
  primitives.
- **Failure tolerance** — observability must never break the chat
  itself.

## Considered options

### Option A — Keep the hand-rolled Redis log; extend its schema

- **Pros:** zero new dependencies; full control over schema and
  storage; already wired up.
- **Cons:** every new query becomes custom code; no built-in
  cost/usage UI; no prompt registry; no eval-score path; weak
  interview narrative ("I wrote my own observability" reads as
  not-invented-here, not strength).

### Option B — Langfuse Cloud (chosen)

- **Pros:** trace/generation/tag/score/prompt primitives out of
  the box; cost computation handles the three prompt-cache token
  buckets correctly; prompt registry with versioning; Edge-compatible
  v3 JS SDK using `fetch`; free Hobby tier sufficient for current
  traffic; interview-recognizable vocabulary.
- **Cons:** external dependency; Hobby-tier ingest lag is variable
  (sub-second to ~10 min); v3 SDK is upstream-deprecated (v4 is
  OTel-based, separate package family); Langfuse Cloud failure
  needs to degrade gracefully.

### Option C — OpenTelemetry directly + a backend of choice (e.g. self-hosted Langfuse, Honeycomb, Grafana Tempo)

- **Pros:** vendor-neutral; OTel is the broader industry standard;
  more flexibility on backend swap.
- **Cons:** more wiring; the LLM-specific concepts (prompt version,
  cost-per-token-bucket, refusal/leak tags) need to be encoded as
  generic OTel attributes — losing the affordances of a
  purpose-built UI; for a portfolio whose point is signal-per-effort,
  this is over-engineering.

## Decision

**Option B — Langfuse Cloud, v3 JS SDK, Tokyo region (`jp.cloud.langfuse.com`).**

Specifics:

- Every `/api/chat` request creates one trace with input/output/userId
  (ipHash) + tags + metadata (userAgent, geoCountry).
- The Sonnet call inside is one generation observation with model,
  input messages, output, token counts (incl. cache buckets), latency,
  TTFT, and a prompt linkage.
- System prompt registered as `tarvis-system-prompt` with a SHA-256
  prefix label (12 hex chars) over canary-normalized content.
- Hand-rolled Redis log keeps writing in parallel as the local audit
  trail. Cutover decision deferred to M3 (`/ops` dashboard).

## Consequences

### Positive

- Cost queries by prompt version, tag, time window, etc. are now
  point-and-click in Langfuse UI instead of custom code.
- Prompt-cache token math surfaces correctly in cost display.
- Prompt versioning makes A/B reasoning about prompt edits possible.
- The trace/generation/score primitives prepare the schema for
  M3 (eval CI gate writes scores) and M4 (online Haiku judge writes
  scores) without further infrastructure work.
- M2 RAG plugs in cleanly — retrieval/rerank become sibling
  observations under the same trace.

### Negative

- External dependency. Mitigated by try/catch around every Langfuse
  call: the chat handler must never break because Langfuse is having
  a bad day.
- Hobby-tier ingest lag of up to ~10 min affects the debugging UX,
  not production correctness. The v4 SDK eliminates this; migration
  is banked in followups.
- v3 SDK is upstream-deprecated. Migration to v4 (the
  `@langfuse/tracing` and `@langfuse/client` family, OTel-based) is
  a separate decision, banked for a focused session when triggered
  by v3 sunset or M2 RAG surfacing v4 features.

### Neutral

- Redis log continues to write. Cost is negligible (one LPUSH per
  turn). Removing it later is a small change once the dashboard
  reads from Langfuse.

## References

- Langfuse TypeScript SDK v3:
  <https://github.com/langfuse/langfuse-js> (v3 branch, deprecated
  but Edge-compatible and feature-complete for M1's needs)
- `api/_langfuse.ts` — client singleton + prompt-handle helper
- `api/chat.ts` — trace creation, tag wiring, generation observation,
  finalize-and-flush
- `scripts/sync-prompt.mjs` — build-time push to Langfuse prompt
  registry with content hash as label
- `docs/observability.md` — primitives writeup
