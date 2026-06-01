# OOC threshold tuning (M3 Phase 5)

## Problem

Pre-Phase-5 state:

- Eval-side cosine floor: `DEFAULT_COSINE_FLOOR = 0.30` in `scripts/eval/dispatch.ts`.
- OOC firing rate: **0%**. The 5 OOC queries (Q14, Q15, Q24, Q25, Q29) live in `evals/categories/absent-facts.json` and ask about topics adjacent to Tushar's portfolio — vox-agent rate-limiting, audio handling in shortlist, Tushar's Rust experience, his blockchain work, whether he has a PhD. None of these are in the corpus, but the corpus contains semantically close material (vox-agent's actual code, shortlist's actual architecture, his actual experience entries), so the embedding model still pulls back chunks with cosines in the 0.37–0.47 band — all above the 0.30 floor. The guardrail metric was structurally pinned at zero regardless of how the floor was set.
- Two possible causes per the spec: floor too low, OR queries too soft. **Both** turned out to apply: the queries are soft-OOC by construction (in-domain but factually absent), and the floor was set without data.

## What changed in this PR

1. **8 new hard-OOC queries** at `evals/categories/out-of-corpus.json` covering weather, sports, current events, recipes, celebrity trivia. Believable as something a user might genuinely ask Tarvis if they're confused about its scope; not adversarial test strings. Spread across `target_source` values (3 readme, 3 experience, 2 resume) for source-scoped retrieval coverage.
2. **`DEFAULT_COSINE_FLOOR` lowered from 0.30 to 0.28** (`scripts/eval/dispatch.ts`). Chosen from the cosine distribution data below; sits in the dead zone between hard-OOC max (0.243) and in-corpus min (0.328) with a slight bias toward in-corpus margin.
3. **`absent-facts.json` `_meta` text updated** to reflect the new floor and to record that absent-facts entries are soft-OOC by intent — they exist to probe the in-domain-but-absent path which the Haiku reranker is responsible for, not the cosine guardrail.

## Cosine distribution at top-1, per query class

Numbers below were captured by running `npm run eval:retrieval` locally against the production Supabase + Voyage embedding model, with the new query file in place. Each row is the top-1 retrieved chunk's cosine against the source-scoped match for that query.

### Hard-OOC (new, this PR — 8 queries)

| id      | top-1 cosine | target_source | query                                       |
| ------- | ------------ | ------------- | ------------------------------------------- |
| ooc-003 | 0.131        | readme        | Who won the cricket world cup final?        |
| ooc-008 | 0.163        | resume        | How tall is LeBron James?                   |
| ooc-002 | 0.193        | readme        | Will it rain tomorrow in Mumbai?            |
| ooc-007 | 0.201        | resume        | Best chocolate chip cookie recipe?          |
| ooc-005 | 0.201        | experience    | Any big news headlines today?               |
| ooc-006 | 0.207        | experience    | How do I make carbonara from scratch?       |
| ooc-004 | 0.231        | experience    | What's the latest NBA score?                |
| ooc-001 | 0.243        | readme        | What's the weather like in Tokyo this week? |

**Range: 0.131 – 0.243. Mean ≈ 0.196.** All comfortably below any reasonable floor candidate.

### Soft-OOC / absent-facts (existing, unchanged — 5 queries)

| id  | top-1 cosine | target_source | query                                       |
| --- | ------------ | ------------- | ------------------------------------------- |
| Q15 | 0.370        | readme        | How does the job-search agent handle audio? |
| Q25 | 0.374        | experience    | Tushar's blockchain work                    |
| Q29 | 0.387        | resume        | Does Tushar have a PhD?                     |
| Q24 | 0.413        | experience    | Tushar's experience with Rust programming   |
| Q14 | 0.467        | readme        | How does vox-agent rate-limit requests?     |

**Range: 0.370 – 0.467.** Above any floor candidate that respects in-corpus parity. These won't fire and aren't expected to — the cosine pre-filter isn't the right tool for in-domain-but-absent queries. Production's Haiku reranker handles them.

### In-corpus (labeled retrieval set — 44 queries)

Summary statistics on top-1 cosines:

| stat      | value                                              |
| --------- | -------------------------------------------------- |
| n         | 44                                                 |
| min       | 0.328 (Q10 — "which of these projects use Python") |
| 5th %ile  | 0.401                                              |
| 10th %ile | 0.403                                              |
| 25th %ile | 0.450                                              |
| median    | 0.504                                              |
| max       | 0.664                                              |

The binding constraint is Q10 at 0.328. Any floor at or above this value risks dropping Q10's top-1 chunk from `visibleToModel` and changing its retrieval@1 outcome.

### Dead zone

`hard-OOC max (0.243)  →  in-corpus min (0.328)` — width **0.085**.

## Floor sweep — threshold vs. in-corpus parity

To verify the chosen floor doesn't degrade labeled-retrieval metrics, I ran the full eval at four candidate thresholds and compared aggregate retrieval scores. Each row is `npm run eval:retrieval -- --threshold=X` on the same dataset.

| threshold             | retrieval@1 | retrieval@3 | retrieval@5 | MRR       | firing rate  |
| --------------------- | ----------- | ----------- | ----------- | --------- | ------------ |
| 0.25                  | 68.2%       | 86.4%       | 86.4%       | **0.847** | 61.5% (8/13) |
| **0.28**              | 68.2%       | 86.4%       | 86.4%       | **0.847** | 61.5% (8/13) |
| 0.30 (prior)          | 68.2%       | 86.4%       | 86.4%       | 0.844     | 61.5% (8/13) |
| 0.32 (in-corpus risk) | 68.2%       | **84.1%**   | **84.1%**   | 0.833     | 61.5% (8/13) |

Read:

- **0.25 / 0.28 / 0.30 are all parity-preserving on in-corpus metrics.** retrieval@1/3/5 identical at 68.2 / 86.4 / 86.4. MRR ticks up 0.003 at 0.28 vs 0.30 because a couple of correct chunks in the (0.28, 0.30) band now appear in `visibleToModel` and bump rank slightly. Cosmetic improvement, not a regression.
- **0.32 breaks parity.** retrieval@3 and @5 drop by ~2.3 percentage points (one query loses a correct chunk to the floor). MRR drops noticeably. Some in-corpus query has a correct chunk with cosine in (0.30, 0.32) that gets dropped from the visible list.
- **Firing rate is constant at 61.5% (8/13) across all four candidates.** The improvement vs. the pre-Phase-5 baseline of 0% is driven entirely by the new hard-OOC query set, NOT by the floor change. This is the honest read: the floor change is for safety margin, not firing-rate gain.

## Chosen floor: 0.28

**Rationale:**

1. Sits in the dead zone (0.243, 0.328). Midpoint = 0.286; 0.28 is essentially the midpoint, rounded down for slightly more in-corpus margin.
2. Preserves in-corpus parity at retrieval@1/3/5 (sweep above confirms).
3. Gives more headroom than 0.30 against future Voyage embedding drift. The current in-corpus min of 0.328 is only 0.028 above the prior 0.30 floor — if a future embedding update shifts the in-corpus tail down by 0.03, the prior floor would have started false-positiving in-corpus queries. 0.28 buys 0.05 of room, doubling the margin.
4. The firing rate of 61.5% (8/13) is the new floor for this metric. To get above ~62% honestly would require either (a) un-tagging the 5 absent-facts queries from `out-of-corpus` (refactor — out of scope for this PR), or (b) writing more hard-OOC queries (incremental — easy follow-up if 8 isn't enough signal).

**Note on the firing rate target.** The spec aspired to ≥80%. The PR achieves 61.5%. The gap is the 5 absent-facts queries that the cosine guardrail isn't the right tool for. The production answer to in-domain-but-absent queries is the Haiku reranker (`api/_reranker.ts`), which the default eval mode doesn't exercise. A follow-up PR could untag absent-facts from `out-of-corpus` and add a separate firing-rate-against-rerank metric to push the cosine guardrail's firing rate over 80% on the queries it's actually responsible for.

## Why this isn't tuning the production floor

`RAG_MIN_COSINE_SIMILARITY` (default 0.15 in `api/_reranker.ts`) is production's cost-control pre-filter, NOT its relevance gate. The relevance gate in production is the Haiku reranker's binary yes/no verdict. The eval's `DEFAULT_COSINE_FLOOR` is a simplified proxy for what production-via-rerank would surface to the model as `tool_result`. Tuning the eval's threshold doesn't change production behavior; it changes the eval's calibration against production behavior. Several stale comments in the eval modules referring to "the production 0.3 cosine floor" were cleaned up in this PR — that text was always misleading; 0.3 was the eval's own threshold from M3 Phase 1, not anything production ran.

## What didn't change

- Production runtime behavior. `RAG_MIN_COSINE_SIMILARITY` still defaults to 0.15. The chat handler doesn't import `DEFAULT_COSINE_FLOOR`.
- The 5 absent-facts queries. They keep their `out-of-corpus` tag and continue to participate in the firing-rate aggregate; the doc records why they won't fire.
- Eval gate semantics. `scripts/eval/gate.ts` doesn't know about the floor specifically; it compares baseline vs. current run on the metrics that exist.

## Verification

Local `npm run eval:retrieval` at the new default (no `--threshold` override):

```
=== Out-of-corpus (guardrail) ===
  ooc queries:               13
  guardrail fired:           8
  guardrail firing rate:     61.5%

=== Overall (labeled queries only) ===
  labeled queries:   44
  retrieval@1:       68.2%
  retrieval@3:       86.4%
  retrieval@5:       86.4%
  MRR:               0.847
```

In-corpus parity: identical retrieval@1/3/5 to the pre-Phase-5 baseline (68.2 / 86.4 / 86.4); MRR up 0.003.
