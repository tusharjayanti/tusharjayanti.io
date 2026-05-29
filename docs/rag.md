# RAG

Notes for me, not the README. The README explains _what_ ships. This
file explains how I think about the primitives so I can answer "how
does your retrieval work?" in an interview without hedging.

## RAG architecture

The foundation: a markdown corpus (`content/experience.md`) becomes a
set of semantically-chunked, embedded rows in Supabase Postgres with
pgvector, and a stored function returns the top-K matches for a query
embedding. Tool-use wiring into `/api/chat` came later — initial
retrieval was reachable only via the smoke script and direct RPC. The
architecture is generalized on a `source` field so resume and project
READMEs plug in without re-migration.

## Schema

One table for every source: `chunks(id, source, source_id,
chunk_index, content, content_hash, embedding vector(1024),
metadata jsonb, created_at, updated_at)`. The schema and indexes
live in [`supabase/migrations/0001_init_chunks.sql`](../supabase/migrations/0001_init_chunks.sql);
service_role grants are in [`0002_chunks_grants.sql`](../supabase/migrations/0002_chunks_grants.sql)
(see [Known issues](#known-issues) for why).

Two invariants matter operationally:

- **Unique key `(source, source_id, chunk_index)`** — re-ingesting the
  same corpus is upsert, not insert. A chunk's identity is its
  position inside its source document.
- **`content_hash` (SHA-256 over normalized content) drives
  idempotency** — ingest only re-embeds when the hash changes.
  Re-running `npm run ingest:experience` against an unchanged file
  reports `27 chunks, 0 created, 0 updated, 27 unchanged, 0 tokens
embedded`. Voyage credit isn't spent on no-op runs.

## Chunking

Every chunk is one H3 section, prefixed with its parent H2 heading.
"Contextual chunking" — the chunk carries enough surrounding context
to be retrievable on its own. The literal content field of one
ingested chunk:

```
PurpleToko (Founding Engineer)
## 0-to-1 backend architecture
Architected the backend systems on AWS for a distributed e-commerce platform...
```

The H2 prefix matters because proper-noun queries (`"what did Tushar
do at PurpleToko"`) need to route to the right section even when the
H3 body doesn't repeat the company name. Without the prefix, only
H3 bodies that happen to mention "PurpleToko" textually would
surface — most don't.

Paragraph-split fallback fires when a single H3 section exceeds 500
tokens: the section is split on blank lines, chunks are sized greedily
up to the budget, and `chunk_index` numbers them in order. The initial
experience corpus produces 27 chunks across 4 H2 sections; no section
hits the fallback.

**Known limitation.** The chunker treats H2 sections as a sequence
of H3 subsections, so non-H3 lines that live directly under an H2
(e.g. `**Dates:** ...`, `**Tech stack:** ...`) are dropped from the
chunks. Banked rather than fixed: future retrieval-quality data will
tell us whether date/stack queries actually fail, which is a better
signal than guessing.

## Embeddings

Voyage `voyage-3`, 1024 dimensions, asymmetric:
`input_type='document'` at ingest, `input_type='query'` at retrieval.
Asymmetric is the table stakes for retrieval-quality embeddings —
documents and queries occupy related but distinct regions of the
embedding space.

Voyage over OpenAI for two reasons: (1) Voyage is now part of
Anthropic post-acquisition, so the embedding stack matches the
inference stack vendor-wise; (2) `voyage-3` benchmarks competitively
with `text-embedding-3-large` while being cheaper at this dimension.
The cost of being on a pre-1.0 SDK (`voyageai@0.0.8`) is real and
covered under [Known issues](#known-issues).

## Retrieval

One stored function, [`match_chunks`](../supabase/migrations/0004_match_chunks_hybrid.sql),
called via Supabase RPC:

```ts
const [queryEmbedding] = await embed([QUERY], 'query');
const { data, error } = await supabase.rpc('match_chunks', {
  query_embedding: queryEmbedding,
  query_text: QUERY,
  match_count: MATCH_COUNT,
  source_filter: SOURCE_FILTER,
});
```

Retrieval is hybrid: semantic (cosine distance over pgvector HNSW)
and lexical (BM25 via Postgres `ts_rank` on the `tsv` generated
column, `english` FTS config) are fused via Reciprocal Rank Fusion
with `k = 60` and equal weights — canonical Cormack-Zobel-Clarke. The
function over-retrieves top-20 from each retriever independently,
joins them on chunk id, and returns the top-`match_count` rows by
fused `score`. Each row carries `semantic_rank`, `bm25_rank`,
`semantic_distance`, and `bm25_score` alongside the fused `score`, so
callers and the reranker can see _why_ a row landed (semantic
neighbor, lexical match, or both) and act on it. A `null` rank means
that retriever didn't see the chunk in its top-20. Keeping the
ranking inside an RPC, rather than expressing it as a client-side
query builder call, meant the hybrid extension was a server-only
migration and the caller signature changes were limited to the new
`query_text` parameter.

## Tool-use integration

`/api/chat` calls retrieval through Anthropic tool-use, not directly.
Three source-scoped tools are exposed to Sonnet — `search_experience`
(detailed role writeups), `search_resume` (compact summaries), and
`search_readme` (GitHub project READMEs) — and the model decides
per-turn whether to call any of them. The tool definitions live in
[`api/_tools.ts`](../api/_tools.ts); each executes one embed + one
`match_chunks` RPC and formats the top-3 chunks as a single
`tool_result` text block.

The chat handler runs one Anthropic streaming session per user turn,
not one per call. Inside that session the stream loop iterates rounds:
text deltas stream to the client immediately (so any preamble Sonnet
emits — "let me look that up" — flows through with no added TTFT),
tool_use blocks accumulate until the round ends, then any tool calls
execute and a follow-up round starts on the same client stream. The
loop exits when Sonnet returns `end_turn`. Cap is 3 rounds per turn,
which is more than the two RAG tools ever need but guards against
runaway loops if a future tool returns ambiguous results.

Langfuse picks up the round structure: one `sonnet-response`
generation per Anthropic call (so per-call token / cache / cost
breakdown survives multi-call turns), one `tool-execution` span per
tool firing, and the per-turn trace carries `rag_retrieved`,
`rag_queries`, `rag_sources`, and `rag_top_chunk_ids` metadata. The
`/ops` dashboard filters on those metadata fields.

The system prompt steers the model toward NOT calling tools for the
common cases (greetings, off-topic refusals, anything already covered
by the inline role-specific facts). This is deliberate — there's
substantial overlap between the inline facts and the corpus today, so
tools should fire only when the inline facts run out. A future
context-compression pass will trim the inline facts once retrieval is
the load-bearing path.

## No-match fabrication guardrail

Tool results are filtered through a cosine-similarity floor before
they reach the model. Each row returned by `match_chunks` passes only
when `(1 - semantic_distance) >= RAG_MIN_COSINE_SIMILARITY` (default
`0.3`, configurable via env). The RRF blended `score` still
determines ranking among surviving chunks; cosine is purely the
quality floor.

The threshold is on cosine similarity, **not on the RRF score**.
RRF with `k = 60` saturates at ~0.033 (= 2 × 1/61 for a chunk that
ranks #1 in both retrievers), so a 0.3 threshold on the RRF axis
would filter every chunk on every query. Cosine similarity has the
standard 0–1 range that makes "0.3 means marginal relevance" portable
across retrieval algorithm choices.

Filter is on cosine only, **not on BM25**. A chunk that scored well
on BM25 but failed the cosine floor is usually term-overlap without
topic relevance (e.g., "errors" in a chatbot README that has nothing
to do with error handling) — better treated as noise than surfaced.

When zero chunks survive the filter, the `tool_result` content
becomes a fixed instruction (see
[`NO_MATCH_TOOL_RESULT` in api/\_tools.ts](../api/_tools.ts)) telling
Sonnet **not to fabricate** and to redirect to contact. The
instruction lives in the tool result rather than the system prompt —
in-context tool-result text is more reliably followed during the
tool-use loop than system-prompt rules. The chat handler tags the
turn's trace with `rag_no_match: true` so the eval gate can surface
fabrication-prone queries.

Operator signal: when no-match fires, the handler emits
`console.log('[rag] no_match', { query, source, threshold })` to
Vercel runtime logs.

### Threshold sweep — why 0.3 stays

The retrieval eval surfaced that at the production `0.3` floor the
guardrail fires on **0/5** out-of-corpus queries — the
fabrication-prevention story was largely fiction. The threshold
sweep tested whether tightening the floor could fix this without
nuking retrieval quality on real queries.

Method: extended [`scripts/eval/retrieval.ts`](../scripts/eval/retrieval.ts)
with a `--threshold=N` flag that filters chunks at the requested
cosine floor before retrieval@k is computed (matching production
behavior — chunks below the floor are invisible to the model). Swept
0.30 / 0.35 / 0.40 / 0.45 / 0.50 against the same 31-query dataset.

| Threshold | retrieval@1 | retrieval@5 | MRR   | OOC firing rate |
| --------- | ----------- | ----------- | ----- | --------------- |
| 0.30      | 69.2%       | **84.6%**   | 0.768 | **0%**          |
| 0.35      | 69.2%       | 80.8%       | 0.749 | 0%              |
| 0.40      | 65.4%       | 76.9%       | 0.705 | 60%             |
| 0.45      | 53.8%       | **61.5%**   | 0.571 | **80%**         |
| 0.50      | 30.8%       | 34.6%       | 0.327 | 100%            |

Decision rule (declared up front): find the highest threshold where
`retrieval@5 ≥ 80%` AND `OOC firing rate ≥ 80%`. **No threshold
satisfies both conditions.** The two signals move in opposite
directions and never cross above the bars.

Detail on the failure mode at the candidate "fix" points:

- **0.45** gets the guardrail firing on 4/5 OOC queries but pushes
  `retrieval@5` to 61.5% — 10 of 26 labeled queries (38%) lose their
  correct chunk to the floor. Per-tag: `experience` drops 100% → 75%,
  `resume` 75% → 50%, `single-source` 100% → 50%. Trading
  fabrication risk on 4 OOC queries for "I don't have that
  information" responses on 10 valid queries is the wrong trade.
- **0.40** is the most balanced point and still misses both bars:
  60% OOC firing, 76.9% `retrieval@5`. The corpus doesn't have a
  threshold value that's both safe and accurate.

Root cause: at 0.40–0.47 cosine, OOC queries (`"Tushar's blockchain
work"` matches experience #20 at 0.374; `"How does vox-agent
rate-limit requests?"` matches vox-agent #1 at 0.467) sit in the
**same cosine band** as some legit vocabulary-poor or generic-
phrasing valid queries. A scalar threshold can't separate them
because they're not separable on the cosine axis.

> **Cosine similarity is a continuous match-score, not a binary
> relevance signal. At our corpus size, semantic-distance bands for
> borderline-relevant and borderline-irrelevant chunks overlap, so a
> scalar threshold cannot separate them. The Haiku reranker is the
> architectural fix, not the next tuning iteration.**

`RAG_MIN_COSINE_SIMILARITY` default stays at `0.3` in the pre-rerank
pipeline. Raising it would shift the failure mode from "fabrication
on OOC queries" to "refusing valid queries" without solving either.
The `--threshold=N` runner support stays in place; once the reranker
ships, the reranker's verdict replaces cosine as the relevance signal.

## Webhook setup

The README ingest loop closes via [`POST /api/github-webhook`](../api/github-webhook.ts).
GitHub pushes the event, the handler verifies the HMAC, filters to
push-on-default-branch-touching-root-README from an allowlisted repo,
and dispatches `ingestReadme` via Vercel's `waitUntil` so the response
returns immediately (202 Accepted) while ingest runs in the background.
Idempotent re-deliveries cost zero LLM tokens — the content_hash short-
circuits both the Haiku summary call and the Voyage embed call.

The webhook isn't installed in the 6 repos yet — that's a manual
post-deploy step. For each repo in
[`rag/ingest/readme-config.ts`](../rag/ingest/readme-config.ts), go to
**Settings → Webhooks → Add webhook** with:

- **Payload URL:** `https://tusharjayanti.io/api/github-webhook` (or
  the Vercel preview URL during testing)
- **Content type:** `application/json`
- **Secret:** the value of `GITHUB_WEBHOOK_SECRET` in the Vercel
  project's environment variables (matches the local `.env.local`)
- **SSL verification:** Enable
- **Which events:** "Just the push event"
- **Active:** checked

After saving, GitHub fires a `ping` event — the handler returns
`200 event ignored` (only `push` is processed). Re-trigger from
**Recent Deliveries** with a synthetic push to verify a real flow,
or simply edit and push the README and watch Vercel function logs.

A single GitHub App across the org-level account is cleaner long-term
but overkill for six repos; this manual per-repo install is the right
size today.

## Retrieval evaluation

A labeled query set + deterministic runner that measures whether the
three-tool pipeline actually surfaces the right chunks. This is the
measurement substrate every future RAG change is compared against —
chunker tweaks, reranker work, tool consolidation, etc.

**Dataset** lives as per-category files under
[`evals/categories/`](../evals/categories/): `rag-retrieval.json` (26
retrieval queries) and `absent-facts.json` (5 in-domain-but-absent
queries — the former `out-of-corpus` set). 31 total, each labeled with
`target_source`, expected `correct_chunks`, and one or more tags
(`realistic`, `adversarial`, `vocabulary-poor`, `single-source`,
`cross-source`, `out-of-corpus`). Distribution: 15 readme, 10 experience,
5 resume, 1 cross-source; the 5 `out-of-corpus` queries live in
`absent-facts.json` for guardrail probing. (IDs Q1–Q31 preserved
from the original single-file dataset.)

**Runner** is [`scripts/eval/retrieval.ts`](../scripts/eval/retrieval.ts),
run via `npm run eval:retrieval`. Embeds all queries in one Voyage
batch, calls `match_chunks` per query against the query's
`target_source`, and computes:

- `retrieval@1` / `@3` / `@5` — fraction of labeled queries where a
  correct chunk appears in the top-K (standard scoring)
- `MRR` — mean reciprocal rank, averaged over labeled queries
- `guardrail_firing_rate` — for `out-of-corpus` queries, fraction
  where zero chunks land above the production 0.3 cosine floor

Scoring differs for the `cross-source` tag: success requires ALL
correct chunks in top-K (single-tool retrieval can't satisfy this by
design). Q31 is the canonical example — the tool-consolidation
question uses the contrast between three-tool and unified retrieval
on cross-source queries as its primary signal.

Per-run output: stdout summary table + a JSON file under
`evals/retrieval/results-<timestamp>.json` so deltas across runs are
diff-able.

### Baseline (2026-05-21)

Run against the post-chunker-refactor corpus (24 experience + 17
resume + 41 readme chunks) and the no-match guardrail (0.3 cosine
floor):

| Metric                      | Value     |
| --------------------------- | --------- |
| retrieval@1 (labeled, n=26) | **69.2%** |
| retrieval@3                 | **84.6%** |
| retrieval@5                 | **84.6%** |
| MRR                         | **0.774** |
| guardrail firing rate (n=5) | **0.0%**  |

Per-tag breakdown:

| Tag             | n   | @1     | @3     | @5     | MRR   |
| --------------- | --- | ------ | ------ | ------ | ----- |
| experience      | 8   | 100.0% | 100.0% | 100.0% | 1.000 |
| single-source   | 2   | 100.0% | 100.0% | 100.0% | 1.000 |
| realistic       | 20  | 80.0%  | 95.0%  | 95.0%  | 0.874 |
| resume          | 4   | 75.0%  | 75.0%  | 75.0%  | 0.750 |
| readme          | 13  | 53.8%  | 84.6%  | 84.6%  | 0.690 |
| vocabulary-poor | 7   | 57.1%  | 71.4%  | 71.4%  | 0.663 |
| adversarial     | 2   | 50.0%  | 50.0%  | 50.0%  | 0.500 |
| cross-source    | 1   | 0.0%   | 0.0%   | 0.0%   | 0.143 |

**Headline observations:**

- **Experience retrieval is solid (100% across the board).** Six chunks
  per role + clean H3 segmentation pay off for the experience corpus.
- **Readme is the weak link at top-1** (53.8%) but recovers by top-5
  (84.6%). The sliding-window-on-H2-only-READMEs structural issue is
  the suspect — vox-agent and TensorflowChatbot lack H3s, so their
  chunks are less semantically focused.
- **Guardrail fires 0/5 on out-of-corpus queries.** Every OOC query
  had chunks at 0.35–0.47 cosine — above the 0.3 production floor.
  The threshold for the no-match guardrail is too lenient for these
  query shapes. Production-side verification succeeded (Rust query →
  guardrail fired) only because Sonnet paraphrased the query to
  "Rust programming language" before calling the tool; the eval uses
  the user's literal phrasing, which cosine-scores higher.
  **Query-phrasing variance dominates threshold behavior** — this is
  a real fabrication risk in production.
- **Cross-source query Q31 fails by design** (first correct chunk at
  rank 7 within the resume-only retrieval; the labeled experience
  chunks are unreachable). The unified-retrieval comparison below
  exercises this against the same query.

This baseline is the comparison point for the tool-consolidation
decision and the Haiku reranker work that follow.

## Tool architecture decision (2026-05-21)

Question asked: keep three source-scoped tools (`search_experience`,
`search_resume`, `search_readme`) or consolidate into one unified
`search_portfolio`? The unified-search-pattern argument is that
source-routing-at-decision-time forces the LLM to guess before
seeing the corpus. Whether that argument transfers to this corpus
shape is an empirical question.

**Method.** Extended `scripts/eval/retrieval.ts` with a
`--mode=three-tool|unified` flag. Added
[`match_chunks_unified`](../supabase/migrations/0008_match_chunks_unified.sql)
— same hybrid (semantic + BM25 + RRF) as `match_chunks` but with no
`source_filter` parameter, so semantic and BM25 top-20 are computed
globally across the whole corpus before fusion. Ran the eval in both
modes against the same 31-query dataset.

### Side-by-side comparison

| Metric                      | Three-tool | Unified   | Δ           |
| --------------------------- | ---------- | --------- | ----------- |
| retrieval@1                 | 69.2%      | 61.5%     | **−7.7pp**  |
| retrieval@3                 | 84.6%      | 80.8%     | −3.8pp      |
| **retrieval@5**             | **84.6%**  | **80.8%** | **−3.8pp**  |
| **MRR**                     | **0.774**  | **0.710** | **−8.3%**   |
| guardrail firing rate (OOC) | 0%         | 0%        | (unchanged) |

Per-tag, the regression concentrates on the tags that ought to have
benefited:

| Tag                    | n   | Three-tool @1 / MRR | Unified @1 / MRR                   |
| ---------------------- | --- | ------------------- | ---------------------------------- |
| readme                 | 13  | 53.8% / 0.690       | 46.2% / 0.612                      |
| vocabulary-poor        | 7   | 57.1% / 0.663       | **42.9% / 0.541**                  |
| **cross-source (Q31)** | 1   | rank=7, MRR=0.143   | **rank=NONE in top-10, MRR=0.000** |

**Decision rule:** unified retrieval@5 (80.8%) < three-tool (84.6%);
unified MRR (0.710) is 8.3% below three-tool (0.774), exceeds the 5%
tolerance. Both gates fail. **Outcome: keep three tools.**

### Why the structural argument cuts the other way here

The "source-routing forces guessing" argument assumes the LLM's
choice of source is roughly random or weak signal — that the model
guesses wrong about as often as it guesses right, so removing the
choice eliminates a coin-flip. That assumption holds when the sources
are **structurally similar** and the question's domain is **ambiguous
across them** — which is the regime of a single-source corpus where
"source-routing" doesn't really apply, and would also be the case
for a corpus of, say, six similarly-shaped technical writeups.

The argument inverts here because:

- **The three sources are structurally different.** Resume chunks are
  short prose summaries of skills and roles. Experience chunks are
  detailed H3-anchored stories with concrete narrative content.
  README chunks are sliding-window slices of project docs with
  embedded code fences and structural markdown. A query about a
  _story_ ("Tushar's Reserve Release work") is structurally a
  better match for experience chunks than for the resume summary
  paragraph; a query about _high-level qualifications_ ("what
  databases does Tushar know") is structurally a better match for
  resume than for any specific experience chunk.
- **The LLM has reliable domain signal.** Sonnet picks `search_resume`
  for "does Tushar know Postgres" and `search_experience` for "the
  p99 latency story" consistently — these are the kinds of queries
  the system prompt's tool descriptions and inline role facts already
  steer effectively. Source routing isn't a coin-flip; it's a
  consistent pre-filter that narrows the candidate pool before
  within-source ranking does its work.
- **Removing the pre-filter dilutes top-K with cross-source noise.**
  Q9 (`"show me the AI evaluation project"`) passed three-tool @3
  but regressed to rank=7 under unified — vox-agent #1 got pushed
  out by resume #5 (AI/LLM systems chunk) and other Python-heavy
  chunks that semantic-match the query without actually being about
  the project the user asked for. Q31 (`"Tushar's Python experience"`)
  showed the same shape: the resume Languages chunk (192 chars,
  generic skill listing) got buried by globally-more-similar chunks
  that mention Python more substantively. The labeled chunks were
  unreachable.

**The unified-search pattern is corpus-dependent.** It wins when the LLM's
source choice carries no signal (one source, or homogeneous sources).
It loses when the LLM's source choice carries strong signal
(structurally different sources, well-aligned tool descriptions) —
which is the regime this corpus operates in today.

### When to re-evaluate

The trade-off shifts as the corpus grows or restructures. Re-run the
three-tool-vs-unified comparison if any of:

- **Total corpus crosses ~150 chunks** (we're at 82 today: 24
  experience + 17 resume + 41 readme). At 2× scale, within-source
  ranking has more candidates to discriminate among, and unified's
  larger candidate pool may surface high-relevance chunks the
  per-source filter would otherwise hide.
- **Any single source exceeds ~50 chunks** (readme is at 41 today,
  closest to the threshold). A source that dominates the corpus
  starts to look like a single-source regime locally — the LLM's
  choice of "search this source" stops being a useful pre-filter
  when most of the corpus is in that source anyway.
- **Adding a 4th source type** (e.g., a blog/writing corpus, or a
  meeting-notes / decision-log corpus). The N-tool design scales
  linearly with sources; at some N the LLM's tool selection becomes
  the bottleneck and unified retrieval gets cheaper to reason about.

Whichever happens first.

The migration ([`0008_match_chunks_unified.sql`](../supabase/migrations/0008_match_chunks_unified.sql))
and the `--mode=unified` runner support stay in place — both are
cheap to retain and ready for the future revisit.

## Reranker architecture (2026-05-22)

The threshold sweep proved that a scalar cosine threshold cannot
separate borderline-relevant from borderline-irrelevant chunks at
this corpus size — the bands overlap at 0.35–0.47, so any single
threshold value trades off retrieval@5 against guardrail firing
rate without ever clearing both. **The Haiku-based listwise reranker
is the architectural fix**: cosine becomes a cost-control pre-filter,
and the reranker is the sole relevance authority.

### Semantic shift: cosine = pre-filter, reranker = relevance

`RAG_MIN_COSINE_SIMILARITY` default is **`0.15`**. The threshold's
job:

- **Pre-rerank pipeline**: relevance signal. Chunks above the floor
  were surfaced; chunks below triggered the no-match guardrail.
- **Post-rerank pipeline**: cost-control pre-filter. Chunks above
  the floor are sent to the reranker for a binary yes/no verdict;
  chunks below are dropped without paying for Haiku.

If the two roles ever blur in code, the design has drifted.

### Pipeline

```
match_chunks (top-K=10)
  → cosine pre-filter @ 0.15 (drops obvious off-topic)
  → if ≤3 survivors: skip Haiku, diversify, return
  → else: seeded shuffle → Haiku listwise verdict
  → drop "no" verdicts
  → if zero survive: NO_MATCH_TOOL_RESULT
  → else: two-pass diversification → top-N=5
```

Reranker implementation lives in
[`api/_reranker.ts`](../api/_reranker.ts). Tool wrappers in
`api/_tools.ts` call `rerankChunks(query, chunks)` before formatting
the `tool_result`. All three source-scoped tools
(`search_experience`, `search_resume`, `search_readme`) flow through
the same reranker — no per-source carve-outs.

**Model:** `claude-haiku-4-5-20251001`, listwise prompt with
`max_tokens: 80` (≈10 chunks × 7 chars per `<id>:<verdict>` pair).
Chunks are truncated to 200 chars before sending — a common
listwise-reranking optimization that trades minimal verdict-quality
loss for input-token savings.

**Position-bias mitigation:** query-seeded Fisher-Yates shuffle of
the candidate list before sending to Haiku. Seed = first 4 bytes of
SHA-256 of the query, so the same query produces the same shuffle
across runs (deterministic eval). Single-pass — multi-pass
averaging is premature at K=10.

**Failure mode:** any Haiku error (timeout, parse failure, 5xx) →
log + fall back to the pre-filter top-N slice, diversified. Same
philosophy as the cache lock: gracefully degrade, never throw to
the user.

### Eval gate (reranker acceptance)

Two metrics, declared up front, measured by
`npm run eval:retrieval -- --rerank`:

| Metric                              | Required    | Reranker result | Status |
| ----------------------------------- | ----------- | --------------- | ------ |
| retrieval@5 (overall, n=26 labeled) | ≥ 80%       | **84.6%**       | ✓      |
| OOC firing rate (n=5 OOC queries)   | ≥ 4/5 (80%) | **4/5 (80%)**   | ✓      |

Per-tag deltas vs. the pre-rerank baseline:

| Tag             | Pre-rerank @5 / MRR | Reranker @5 / MRR | Δ               |
| --------------- | ------------------- | ----------------- | --------------- |
| experience      | 100% / 1.000        | 87.5% / 0.875     | regressed on Q6 |
| resume          | 75% / 0.750         | 75% / 0.750       | unchanged       |
| readme          | 84.6% / 0.690       | **92.3% / 0.808** | improved        |
| vocabulary-poor | 71.4% / 0.663       | **85.7% / 0.714** | improved        |
| realistic       | 95% / 0.874         | 90% / 0.875       | -5pp on @5 (Q6) |
| adversarial     | 50% / 0.500         | 50% / 0.500       | unchanged       |
| cross-source    | 0% / 0.143          | 0% / 0.000        | structural      |

Notable: the OOC subset shifted from 0/5 → 4/5 firing. Q14
(`"How does vox-agent rate-limit requests?"`) is the one silent
case — Haiku said "yes" to a `tusharjayanti.io` chunk that does
discuss rate-limiting (just not in vox-agent). Reasonable
interpretation; banked for follow-up.

**Banked findings** (to future work):

- **Q6 regression**: `"Tushar's experience at DISCO"` was 100% at
  every k in the pre-rerank pipeline; the reranker now drops all 7
  DISCO experience chunks. Likely Haiku reading the query as too
  vague to materially answer until a specific topic is named. Tuning
  options: loosen the system prompt's strictness on broad role
  queries, or re-label Q6 with explicit topical sub-chunks. Net
  effect doesn't break the gate (overall @5 unchanged at 84.6%) but
  it's a real behavioral shift to watch.
- **Q14 silence**: described above. Defensible Haiku judgment
  rather than a clear bug.

The reranker is the relevance authority. The architecture ships;
tuning iterates on the prompt and corpus, not on the threshold.

## Operations

Three commands cover day-to-day:

**`npm run ingest`** — embed and upsert every markdown source in
`content/` in sequence (experience.md, resume.md, READMEs, docs).
Default ingest workflow. Idempotent at the source level: each source
diffs against its own DB rows and only re-embeds when `content_hash`
changes. Success looks like one `ingest:<source> ok: ...` line per
configured source. Fails fast — if a source throws, subsequent
sources don't run.

**`npm run ingest:experience`** / **`npm run ingest:resume`** —
per-source helpers, identical pipeline to `npm run ingest` but scoped
to one source. Use when iterating on a single corpus to skip the cost
of re-checking the others. Same output format and idempotency
semantics.

**`npm run smoke:retrieval`** — embed a hardcoded query against the
experience corpus and print the top 3 hits with hybrid retrieval
attribution (RRF score + per-retriever ranks, plus `source_id`,
`chunk_index`, H2/H3 metadata, content preview). Run after migrations
or chunker changes to confirm retrieval still returns sensible
results. Success is three results with sensible top-1 attribution.

**`supabase db push`** — apply pending migrations under
`supabase/migrations/` to the linked project. Run after authoring a
new migration file. Success is either applied migrations listed or
`Remote database is up to date.`

## What this isn't (yet)

Honest gaps that remain:

- **H2-preamble lines dropped.** As noted above, `**Dates:**` and
  `**Tech stack:**` lines that live directly under an H2 (no H3
  inside the section) are not in any chunk today. The chunker is
  H3-based with no fallback for H2-only sections.

- **No multi-turn context.** Each chat turn is a single user
  message; there's no session linkage across turns, so "tell me
  more about that" doesn't work. Banked for after retrieval
  foundations stabilize.

- **No closed-loop eval generation.** Low-scored or
  fabrication-prone production traces aren't yet promoted to eval
  cases automatically. Today's retrieval eval is offline against a
  hand-curated query set; mining failing production traces into new
  eval cases is future work.

README auto-sync, the Haiku reranker, and the no-match fabrication
guardrail all shipped — see the sections above. Context compression
of the inline system-prompt facts is banked but not yet scheduled.

## Known issues

- **Supabase free-tier auto-pause.** The project pauses after 7 days
  of inactivity; the first request after a pause has roughly a 30s
  cold start. Not a problem during active development; will need a
  decision before the demo is shared widely (paid tier vs. keepalive
  ping vs. accept the cold start as a "Supabase free tier" caveat).

- **Voyage SDK is pre-1.0.** `voyageai@0.0.8`, pinned exactly (no
  `^`) in `package.json`. The SDK has shipped breaking changes
  between patch versions before; any upgrade goes through a manual
  smoke run before getting committed. Migration to a stable 1.0 line
  is followups-tracked.

- **service_role grants on user-created tables.** Supabase's new
  `sb_secret_*` key format authenticates as `service_role`, but
  tables created via `supabase db push` migrations don't inherit
  the default grants that the dashboard's table editor applies.
  Codified explicitly in
  [`0002_chunks_grants.sql`](../supabase/migrations/0002_chunks_grants.sql).
  Any new RAG table needs an equivalent grant migration.
