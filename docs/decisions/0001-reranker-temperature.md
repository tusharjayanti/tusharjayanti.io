# ADR 0001: Pin reranker temperature to T=0

## Status

Accepted — 2026-05-26

## Context

The Haiku reranker (`api/_reranker.ts`) makes yes/no relevance
verdicts on retrieved candidate chunks. Each rerank request
calls Claude Haiku once with a batch of chunks and parses the
yes/no verdicts from a structured output.

While designing the eval-gated CI, I discovered the reranker
call runs at the Anthropic SDK default temperature (1.0) — no
temperature parameter is explicitly set. This makes verdicts
non-deterministic: identical inputs can produce different
verdicts run-to-run.

This matters because eval metrics (retrieval@1,
retrieval@5, MRR, OOC firing rate) computed against a
non-deterministic judge will drift between runs even without
code changes. CI gates against drifting metrics produce either
flaky CI or require buffers wide enough to hide real
regressions.

## Decision

Pin the Haiku reranker call to `temperature: 0` in
`api/_reranker.ts`.

The pin is a partial mitigation, not a determinism guarantee.
My empirical investigation showed that T=0 halves observed
eval-set drift but does not eliminate it. The residual ~4pp
drift is structural LLM inference non-determinism that no
client-side parameter controls.

I'm pinning anyway because it's a small, low-risk change that
removes ~50% of eval-time variance at zero measured quality
cost. The threshold design accounts for the residual via
tolerance bands, not absolute thresholds.

## Options considered

### Option A — Pin to T=0 (chosen)

- Pros: Halves eval drift. Consistent visitor experience (same
  query produces same answer). Zero quality regression measured.
- Cons: Bakes Haiku's borderline-case biases in. Doesn't
  eliminate eval drift; the eval gate still needs tolerance bands.

### Option B — Leave at SDK default (T=1.0)

- Pros: Maximum variance, which spreads borderline-case errors
  across calls — for production traffic, the "true" model
  distribution shows through over many queries.
- Cons: 7.7pp drift between back-to-back eval runs (measured).
  Inconsistent visitor experience. Eval thresholds either need
  large tolerance bands or relative-to-baseline gates with
  wide margins.

### Option C — Low non-zero (T=0.1 to T=0.3)

- Pros: Compromise between determinism and per-query averaging.
- Cons: Adds complexity for marginal benefit. Doesn't fully
  solve either problem.

### Option D — Majority voting at T=1.0 (3 calls, take majority)

- Pros: True averaging within a single call site. Collapses
  borderline flips to near-zero. Most robust solution.
- Cons: 3× rerank API spend. 3× rerank latency (unless
  parallelized). Significant architectural change.

I'm deferring Option D as a future improvement (banked as a
followup). Option A is the current step; D becomes relevant if
the tolerance-band approach proves insufficient in practice.

## Experimental evidence

Two-experiment investigation conducted 2026-05-26. Per-experiment
detail summarized below.

### Experiment A — Per-chunk verdict variance

I ran a single query (Q9, "show me the AI evaluation project")
through the reranker 20 times at each temperature. All 10
candidate chunks produced identical yes/no verdicts across all
20 runs at both temperatures.

I picked Q9 because its correct chunk was at rank 2, expecting
that proximity to suggest judge uncertainty. The chunks at the
rank boundary turned out to be confidently ranked — the rank-2
position was an ordering artifact among two confident "yes"
verdicts, not judge uncertainty. So Q9 was not representative
of broader noise behavior; I had to look elsewhere.

### Experiment B — Aggregate metric drift

I ran the full 31-query eval set 3 times at each temperature.

| Temperature | retrieval@5 range           | MRR range     | OOC firing   |
| ----------- | --------------------------- | ------------- | ------------ |
| T=1.0       | 73.1% – 80.8% (7.7pp drift) | 0.692 – 0.769 | 5/5 all runs |
| T=0.0       | 76.9% – 80.8% (3.9pp drift) | 0.731 – 0.769 | 5/5 all runs |

Pinning T=0 halves observed drift but does not eliminate it.

### Layer-by-layer noise source identification

I traced the residual T=0 drift via direct layer probes on Q26
("what databases does Tushar know") — the specific query that
flipped between my T=0 runs.

| Layer                          | Test                          | Result                       |
| ------------------------------ | ----------------------------- | ---------------------------- |
| Voyage embedding               | embed Q26 ×10                 | Bit-identical (max diff = 0) |
| match_chunks (fixed embedding) | retrieve ×10                  | 1 ordering                   |
| match_chunks (fresh embedding) | embed + retrieve ×10          | 1 ordering                   |
| Haiku judge at T=0             | rerank ×20 (fixed candidates) | resume.md#3: 16 yes / 4 no   |

Embedding and retrieval are fully deterministic. The residual
drift is structural non-determinism in the LLM inference layer
itself — floating-point accumulation, request batching, and
hardware routing. No client-side parameter eliminates this. For
verdicts near the model's decision boundary, the ~20% flip
rate at T=0 is intrinsic.

### Noise quantization

Eval drift is quantized in ~3.85pp units (1/26 labeled queries).
Each "borderline" query — one whose verdict on a relevant chunk
sits near the decision boundary — contributes one possible
flip per run.

At T=0: 1 borderline query observed (Q26).
At T=1: 2 borderline queries observed (Q26 + Q16).

The planned eval set expansion (31 → ~46) will dilute per-flip
noise from ~3.85pp to ~2.17pp.

## Consequences

- `api/_reranker.ts` line ~219 will include `temperature: 0`
  in the `client.messages.create` call.
- Production visitor experience: more consistent answers to
  the same query over time. Previously, repeated queries could
  produce different chunk subsets and slightly different
  generated answers.
- Eval-gated CI design must use tolerance bands (e.g.,
  "retrieval@5 must not drop more than N pp below baseline")
  rather than absolute thresholds. The tolerance N must
  accommodate the observed ~4pp quantized noise at T=0,
  shrinking as the eval set grows.
- If borderline-case accuracy issues surface later (e.g.,
  the reranker over-rejects a class of chunks it previously
  accepted half the time), the fix is improving the reranker
  prompt or the chunk content — not adding sampling variance
  back.

## Followups

Three related work items banked separately:

- **match_chunks tiebreaker fix:** Three ORDER BY clauses in
  the hybrid retrieval SQL lack deterministic secondary keys.
  Independent of this decision, but eliminates a different
  noise class (lexical-tie noise) that didn't bite Q26 but
  could affect other queries.
- **Judge majority voting (Option D above):** Future
  improvement if tolerance bands prove insufficient. ~3×
  rerank cost, near-zero borderline flip rate.
- **Hardware-level non-determinism methodology note:**
  Documents the floor below which client-side parameters
  cannot reduce LLM variance. Relevant for any future
  LLM-judge design.
