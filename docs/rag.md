# RAG

Notes for me, not the README. The README explains _what_ ships. This
file explains how I think about the primitives so I can answer "how
does your retrieval work?" in an interview without hedging.

## RAG architecture (M2.1)

M2.1 ships the foundation: a markdown corpus (`content/experience.md`)
becomes a set of semantically-chunked, embedded rows in Supabase
Postgres with pgvector, and a stored function returns the top-K
matches for a query embedding. Tool-use wiring into `/api/chat`
arrives in M2.4 — until then retrieval is reachable only via the
smoke script and direct RPC. The architecture is generalized on a
`source` field so M2.3 (resume) and M2.5 (project READMEs) plug in
without re-migration.

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
up to the budget, and `chunk_index` numbers them in order. Under M2.1
the experience corpus produces 27 chunks across 4 H2 sections; no
section currently hits the fallback.

**Known limitation.** The chunker treats H2 sections as a sequence
of H3 subsections, so non-H3 lines that live directly under an H2
(e.g. `**Dates:** ...`, `**Tech stack:** ...`) are dropped from the
chunks. Banked rather than fixed: M3 retrieval-quality data will
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

M2.2 made retrieval hybrid: semantic (cosine distance over pgvector
HNSW) and lexical (BM25 via Postgres `ts_rank` on the `tsv` generated
column, `english` FTS config) are fused via Reciprocal Rank Fusion
with `k = 60` and equal weights — canonical Cormack-Zobel-Clarke. The
function over-retrieves top-20 from each retriever independently,
joins them on chunk id, and returns the top-`match_count` rows by
fused `score`. Each row carries `semantic_rank`, `bm25_rank`,
`semantic_distance`, and `bm25_score` alongside the fused `score`, so
callers and the M2.6 reranker can see *why* a row landed (semantic
neighbor, lexical match, or both) and act on it. A `null` rank means
that retriever didn't see the chunk in its top-20. Keeping the
ranking inside an RPC, rather than expressing it as a client-side
query builder call, means M2.2 was a server-only migration and the
caller signature changes were limited to the new `query_text`
parameter.

## Tool-use integration (M2.4)

`/api/chat` calls retrieval through Anthropic tool-use, not directly.
Three source-scoped tools are exposed to Sonnet — `search_experience`
(detailed role writeups), `search_resume` (compact summaries), and
`search_readme` (GitHub project READMEs, M2.5) — and the model decides
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
M3 `/ops` dashboard will filter on those metadata fields.

The system prompt steers the model toward NOT calling tools for the
common cases (greetings, off-topic refusals, anything already covered
by the inline role-specific facts). This is deliberate — there's
substantial overlap between the inline facts and the corpus today, so
tools should fire only when the inline facts run out. M2.7 (context
compression) will trim the inline facts once retrieval is the
load-bearing path.

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
[`NO_MATCH_TOOL_RESULT` in api/_tools.ts](../api/_tools.ts)) telling
Sonnet **not to fabricate** and to redirect to contact. The
instruction lives in the tool result rather than the system prompt —
in-context tool-result text is more reliably followed during the
tool-use loop than system-prompt rules. The chat handler tags the
turn's trace with `rag_no_match: true` so M3 evals can surface
fabrication-prone queries.

Operator signal: when no-match fires, the handler emits
`console.log('[rag] no_match', { query, source, threshold })` to
Vercel runtime logs.

## Webhook setup (M2.5)

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

## Operations

Three commands cover day-to-day:

**`npm run ingest`** — embed and upsert every markdown source in
`content/` in sequence (currently `experience.md` + `resume.md`;
project READMEs join in M2.5). Default ingest workflow. Idempotent at
the source level: each source diffs against its own DB rows and only
re-embeds when `content_hash` changes. Success looks like one
`ingest:<source> ok: ...` line per configured source. Fails fast — if
a source throws, subsequent sources don't run.

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

Not pretending. Honest gaps:

- **No project README auto-sync.** Project descriptions still live in
  the system prompt. M2.5 wires GitHub webhooks to ingest READMEs
  from the projects Tushar maintains, keyed off repo metadata.

- **No reranking.** Top-K is whatever cosine says. M2.6 runs a Haiku
  reranker over the K=20 retrieval set to pick the K=4 most
  load-bearing chunks for the model.

- **No context compression.** Retrieved chunks land in the prompt
  verbatim. M2.7 adds Haiku-driven extractive compression to keep
  the chat handler under the cache breakpoint.

- **H2-preamble lines dropped.** As noted above, `**Dates:**` and
  `**Tech stack:**` lines that live directly under an H2 are not in
  any chunk today.

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
