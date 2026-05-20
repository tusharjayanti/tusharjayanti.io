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

One stored function, [`match_chunks`](../supabase/migrations/0003_match_chunks.sql),
called via Supabase RPC:

```ts
const [queryEmbedding] = await embed([QUERY], 'query');
const { data, error } = await supabase.rpc('match_chunks', {
  query_embedding: queryEmbedding,
  match_count: MATCH_COUNT,
  source_filter: SOURCE_FILTER,
});
```

The function returns rows ordered by ascending cosine distance, with
`score = 1 - cosine_distance` so higher means closer. M2.1 is
semantic-only; M2.2 extends in place (`create or replace`) to fuse
BM25 lexical scores into the same ranking. Keeping retrieval behind
an RPC, rather than expressing it as a client-side query builder
call, means the M2.2 migration is server-only and callers don't
change.

## Operations

Three commands cover day-to-day:

**`npm run ingest:experience`** — embed and upsert the experience
corpus. Idempotent: re-running against unchanged content does zero
work and consumes zero Voyage tokens. Run after editing
`content/experience.md` or after applying a migration that changes
chunk shape. Success looks like
`ingest:experience ok: 27 chunks, N created, M updated, K unchanged, T tokens embedded`.

**`npm run smoke:retrieval`** — embed a hardcoded query and print the
top 3 hits with attribution (`source_id`, `chunk_index`, H2/H3
metadata, content preview). Run after migrations or chunker changes
to confirm retrieval still returns sensible results. Success is
three results scoped to the expected H2 section.

**`supabase db push`** — apply pending migrations under
`supabase/migrations/` to the linked project. Run after authoring a
new migration file. Success is either applied migrations listed or
`Remote database is up to date.`

## What this isn't (yet)

Not pretending. Honest gaps:

- **No BM25 hybrid retrieval.** M2.1 is cosine-similarity only.
  Proper-noun queries land correctly today because the H2 prefix
  pulls them into the right neighborhood, but a pure lexical match
  on `"Elasticsearch"` won't beat a semantic match on
  `"search infrastructure"`. M2.2 adds BM25 + reciprocal-rank fusion
  in the same `match_chunks` RPC.

- **No PDF / resume ingest.** Only the markdown experience corpus is
  in. M2.3 adds resume ingest via PDF text extraction → markdown
  normalization → same chunker.

- **No project README auto-sync.** Project descriptions still live in
  the system prompt. M2.5 wires GitHub webhooks to ingest READMEs
  from the projects Tushar maintains, keyed off repo metadata.

- **No reranking.** Top-K is whatever cosine says. M2.6 runs a Haiku
  reranker over the K=20 retrieval set to pick the K=4 most
  load-bearing chunks for the model.

- **No context compression.** Retrieved chunks land in the prompt
  verbatim. M2.7 adds Haiku-driven extractive compression to keep
  the chat handler under the cache breakpoint.

- **`/api/chat` doesn't call retrieval yet.** The pipeline is live,
  the chat handler doesn't use it. M2.4 wires Anthropic tool-use so
  the model decides _whether_ to retrieve and what to query for —
  rather than retrieving on every turn.

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
