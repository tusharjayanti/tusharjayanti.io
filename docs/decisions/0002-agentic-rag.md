# ADR 0002 — Agentic RAG foundation: Supabase pgvector + Voyage embeddings, retrieval behind an RPC

- **Status:** Accepted (M2.1, May 2026)
- **Deciders:** Tushar
- **Supersedes:** N/A

## Context

By the end of M1, Tarvis had observability but no real knowledge base.
Role facts and project descriptions lived inline in the system prompt,
prompt-cached on every turn. That arrangement holds while the corpus
is small and stable; it breaks the moment any of these is true:

- The corpus grows beyond a few KB (projects, READMEs, longer-form
  writeups) and pushes the prompt past the cache breakpoint.
- A reviewer pastes a job description, and the model needs to retrieve
  the relevant projects rather than relying on what's pre-inlined.
- A new project ships and its description needs to be available
  without a manual prompt edit + redeploy.

M2 is the agentic RAG phase: knowledge moves out of the system prompt
into a retrieval layer; the model decides _whether_ to retrieve via
tool use; the system prompt stays small and cacheable. M2.1 is the
foundation sub-phase — schema, chunking, embeddings, retrieval RPC —
under which the rest of M2 plugs in. None of the wiring into
`/api/chat` happens here; that's M2.4.

Two upstream signals shaped the decision space:

- An externally-observed portfolio-scale RAG architecture
  demonstrates the destination shape: pgvector + BM25 hybrid, Haiku
  reranking, eval-driven CI gates. The pipeline architecture is
  described in published writeups; the underlying schema is not.
- Anthropic's Voyage acquisition (early 2026) means the embedding
  layer can now share a vendor with the inference layer, which both
  simplifies the stack narrative and bets that Voyage will see
  continued investment.

## Decision drivers

- **Pgvector in same Postgres as future BM25** — keeping vector and
  lexical retrieval in one store avoids a second database for the
  M2.2 hybrid extension.
- **Embedding vendor alignment with the rest of the stack** — fewer
  vendors to reason about for the LLMOps narrative.
- **Retrieval API surface that survives M2.2** — adding BM25 should
  be a server-only change.
- **Idempotent ingest** — local edits to the corpus should not burn
  Voyage credits on no-op runs.
- **Source generality from day one** — schema must support experience
  (M2.1), resume (M2.3), and README sources (M2.5) without
  re-migration.

## Considered options

### Storage: Supabase pgvector (chosen) vs. Upstash Vector vs. self-hosted Postgres

- **Supabase pgvector:** one database for vector and (later) BM25;
  managed Postgres with reasonable free tier; service_role key fits
  Edge runtime; migrations via `supabase db push`. Costs: free-tier
  auto-pause after 7 days inactivity; service_role grants don't
  auto-apply on user-created tables under the new `sb_secret_*` key
  format (codified in [`0002_chunks_grants.sql`](../../supabase/migrations/0002_chunks_grants.sql)).
- **Upstash Vector:** same vendor as the existing Redis store; clean
  Edge SDK. Cons: no obvious path to add BM25 to the same store, so
  M2.2 would need a second vendor or a different hybrid strategy. The
  M2.2 sequencing was the deciding constraint.
- **Self-hosted Postgres:** maximal control; not on the Edge story
  Tarvis already uses, and one more thing to operate for no
  portfolio signal.

### Embeddings: Voyage (chosen) vs. OpenAI vs. Cohere/Jina

- **Voyage `voyage-3`, 1024 dims, asymmetric:** Anthropic-aligned
  post-acquisition; competitive quality at lower cost than
  `text-embedding-3-large`. Cons: SDK is pre-1.0 (`0.0.8`); pinned
  exactly with breaking-change risk on upgrades.
- **OpenAI `text-embedding-3-large`:** stable SDK, broadly familiar.
  Cons: adds an OpenAI dependency to an otherwise Anthropic-only
  inference stack — weakens the "single-vendor-where-it-matters"
  narrative.
- **Cohere / Jina:** both have credible embedding APIs. Neither
  contributes signal a recruiter would recognize beyond "this person
  picked a reasonable model"; same surface, no narrative bonus.

### README sync: GitHub webhooks (chosen, future M2.5) vs. daily cron

- **Webhooks** trigger ingest on README push — content stays fresh,
  ingest only runs when there's something to ingest. Cons: more
  moving parts (webhook secret, verification, dedup on retries).
- **Daily cron** is simpler but means README edits can lag a day,
  and consumes Voyage credits on no-op runs unless the idempotency
  check fires inside the cron job. The idempotency win is already
  paid for by the `content_hash` mechanism, but the freshness gap
  matters when a reviewer is looking at a brand-new project.

### Retrieval API: stored function via RPC (chosen) vs. client-side query builder vs. raw pg client

- **`match_chunks` RPC** keeps the SQL on the server; M2.2 adds BM25
  via `create or replace` migration and callers don't change.
- **Client-side query builder** (Supabase JS): the ranking expression
  lives in the caller; M2.2 would touch every call site.
- **Raw `pg` client over a connection pool:** strictly more flexible;
  adds dependency surface and a connection-pooling problem on Edge
  for zero benefit at this scale.

## Decision

**Supabase pgvector + Voyage `voyage-3` (1024 dims, asymmetric) +
`match_chunks` RPC, generalized on a `source` column, with content
hash-based ingest idempotency. GitHub-webhook README sync deferred to
M2.5.**

Specifics:

- One `chunks` table for all sources, keyed by
  `(source, source_id, chunk_index)`. Schema in
  [`supabase/migrations/0001_init_chunks.sql`](../../supabase/migrations/0001_init_chunks.sql);
  grants in
  [`0002_chunks_grants.sql`](../../supabase/migrations/0002_chunks_grants.sql).
- Contextual chunking: each chunk is one H3 section prefixed by its
  H2 heading; 500-token paragraph-split fallback for oversized
  sections.
- Asymmetric Voyage embeddings: `input_type='document'` at ingest,
  `input_type='query'` at retrieval.
- Retrieval via [`match_chunks(query_embedding, match_count,
  source_filter)`](../../supabase/migrations/0003_match_chunks.sql);
  returns `score = 1 - cosine_distance`.
- Ingest is idempotent via SHA-256 `content_hash` per chunk; no-op
  runs consume zero Voyage tokens.

## Consequences

### Positive

- One store for vector and (M2.2) BM25 — no two-database problem.
- Embedding vendor aligns with inference vendor — simpler stack
  narrative.
- Retrieval API survives M2.2 unchanged from the caller side.
- Adding a new source (M2.3 resume, M2.5 READMEs) is a chunker
  change plus an ingest script; no schema migration.
- The `chunks` table is also the eventual home for any source where
  retrieval makes sense (decision logs, blog posts) — generality is
  free once it's there.

### Negative

- **New vendors.** Supabase and Voyage join Anthropic, Upstash,
  Resend, Cloudflare, Vercel, and Langfuse. Each new vendor is one
  more thing that can be down, one more set of credentials, one
  more billing surface. Justified here by the M2.2 sequencing
  constraint and the embedding-stack narrative.
- **Pre-1.0 Voyage SDK.** `voyageai@0.0.8`, pinned exactly. Upgrades
  go through a manual smoke run; tracked in followups.
- **Webhook infrastructure debt deferred to M2.5.** Webhook
  verification, retry dedup, and rate-limit-on-the-ingest-path all
  arrive when M2.5 does.
- **Supabase free-tier auto-pause.** 7-day inactivity causes ~30s
  cold start on first request after pause. Acceptable during
  development; revisited before the demo URL is shared widely.

### Neutral

- M2.1 ships infrastructure with no user-visible effect. `/api/chat`
  doesn't call retrieval until M2.4. That's deliberate — wiring
  retrieval into the chat handler before retrieval itself is solid
  would mean shipping a regression in the user-facing path to
  unblock infrastructure work.

## Banked observations

- **The reference portfolio's schema is not directly verifiable from
  its public repo.** The pipeline architecture (pgvector + BM25
  hybrid + Haiku reranking + eval CI) is documented in writeups; the
  actual chunk table shape is not. The schema here was designed
  independently from operational requirements (one `source` column,
  idempotent ingest, RPC for retrieval), with the pipeline
  architecture borrowed. Borrow the architecture, build the
  implementation.
- **service_role grants do not auto-apply** on tables created via
  `supabase db push` migrations under the new `sb_secret_*` key
  format. The dashboard's table editor applies them automatically;
  the CLI does not. Codified in
  [`0002_chunks_grants.sql`](../../supabase/migrations/0002_chunks_grants.sql)
  and any future RAG table needs an analogous grant migration.

## References

- `supabase/migrations/0001_init_chunks.sql` — schema + pgvector
  index.
- `supabase/migrations/0002_chunks_grants.sql` — service_role grants
  (see banked observation above).
- `supabase/migrations/0003_match_chunks.sql` — retrieval RPC; M2.2
  will extend in place.
- `rag/chunking/` — contextual chunker.
- `rag/ingest/experience.ts` — ingest pipeline for the experience
  corpus.
- `scripts/rag/ingest-experience.ts` — CLI entry point.
- `scripts/rag/smoke-retrieval.ts` — end-to-end smoke test.
- `docs/rag.md` — primitives writeup.
