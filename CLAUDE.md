# tusharjayanti.io

## What this is

AI-chatbot-style portfolio for Tushar Jayanti, senior backend engineer pivoting to AI engineering. Public site at tusharjayanti.io. The portfolio is a tool to get interviews — every decision should serve that goal.

## Stack

- Frontend: Vite + React 19 + TypeScript + React Router v7, Catppuccin Mocha
- Backend: Vercel Edge Functions for /api/\*
- Data: Upstash Redis (Mumbai) — chat logs, error logs, rate-limit counters
- Email: Cloudflare Email Routing (inbound, tj@tusharjayanti.io → Gmail) + Resend (outbound, Tokyo region,
  tusharjayanti.io)
- Observability: Langfuse Cloud (Tokyo region, jp.cloud.langfuse.com) — primary trace destination
- DNS / domain: Cloudflare Registrar + DNS
- Models: Claude Sonnet 4.6 for chat; Haiku 4.5 planned for future evals
- Deploy: Vercel auto-deploy from main (push = production)

## Repo layout

- src/ — React app (terminal + cv modes, commands, content)
- api/ — Vercel Edge Functions (chat.ts, cron/digest.ts, \_kv, \_injection, \_refusal, \_resend, \_langfuse, \_compat, \_systemPrompt.txt + .ts)
- scripts/sync-prompt.mjs — syncs \_systemPrompt.txt to .ts on predev/prebuild
- vercel.json — crons + SPA rewrites
- public/ — static assets

## Locked conventions (do not relitigate without explicit reason)

### Dev workflow

- npm run dev → frontend dev (Vite, port 5173). Use for UI work.
- npm run dev:edge → API dev (vercel dev, port 3000). Use ONLY for /api/\* curl testing. Don't load the frontend through it — the SPA rewrite in vercel.json conflicts with Vite's dev module paths.

### SPA routing

- Rewrite committed in vercel.json: /((?!api/|.\*\.).+) → /index.html
- This is the canonical Vercel SPA fallback pattern (Option C).
- Do NOT move it to build-time injection — Vercel reads vercel.json before running the build command, so build-time injection is too late.

### ESM imports in api/

- TypeScript moduleResolution is node16/nodenext, so relative imports in api/ REQUIRE explicit .js extensions — including dynamic `await import('./foo.js')` (this gap caused a production build failure).
- Extension sweeps must grep BOTH `from '...'` (static) AND `import('...')` (dynamic).

### Rate limiting

- IP-based (SHA-256 hash), 40 requests per hour-bucket per IP.
- Key: `rl:chat:${ipHash}:${hour}` where hour is the UTC hour stamp.
- EXPIRE unconditional, 2-hour TTL (TTL is GC; the window is in the key name).
- Replacement plan: Cloudflare Turnstile (behavioral). Sequencing rule: add Turnstile first, verify, THEN remove rate limiting — never an unprotected gap.

### System prompt

- Source of truth: api/\_systemPrompt.txt (editable plain text, contains a `{{CANARY_TOKEN}}` placeholder on line 1)
- Synced to api/\_systemPrompt.ts via scripts/sync-prompt.mjs on predev/prebuild
- Canary token rotates per deploy: scripts/sync-prompt.mjs generates a fresh `cnry_<16-hex>` via `crypto.randomBytes` on every build and substitutes it into the placeholder. `CANARY_TOKEN` env var overrides generation (intended for local stability — without it, every dev run rotates the canary and produces a noisy diff on `_systemPrompt.ts`).
- Prompt versioning: sync-prompt also computes a SHA-256 prefix (12 hex chars) over the canary-substituted body and pushes the prompt to Langfuse under name `tarvis-system-prompt` with that hash as the label. The integer version returned by Langfuse is stored in `PROMPT_VERSION_NUMBER` (the hash itself in `PROMPT_VERSION`). chat.ts builds a minimal prompt handle from these constants and attaches it to every generation observation — no runtime Langfuse API call. Push skips silently if `LANGFUSE_*` env vars are missing (`PROMPT_VERSION_NUMBER` falls back to 0, prompt linkage is omitted), and any push error is non-fatal.

### Voice / behavior

- Chat is named "Tarvis" in the autoplay banner only. The system prompt speaks as Tushar's voice — Tarvis is a UI label, not an in-character persona.
- Voice register: Tony Stark / Jarvis. Direct, dry, competent, no apology for constraints.
- Errors are voice-consistent (see api/chat.ts error messages).
- The ¯\_(ツ)\_/¯ shrug appears across 4 surfaces deliberately (server errors, cat/ls not-found, chat genuine uncertainty). It's a signature, not decoration.

### Observability

- Langfuse Cloud (Tokyo / jp.cloud.langfuse.com) is the primary trace destination as of M1.1. Every `/api/chat` request emits one trace (`chat-turn`) with input, output, userId (ipHash), and tags from the taxonomy below. The Sonnet streaming call inside is one `generation` observation capturing model, input messages, output, token counts (input/output/total + cache_creation/cache_read), latency, time-to-first-token, and a prompt linkage to the Langfuse-registered version (M1.2 — see "System prompt" above).
- Edge runtime: `flushAt: 1` on the Langfuse client and an explicit `flushAsync()` at end of request — Edge has no persistent process to batch for. Langfuse failures are caught and logged; they never break user-facing chat.
- Existing Redis chat log continues in parallel — every chat still writes to chat:log:YYYY-MM-DD (rolling list, 30-day TTL). Cutover decision deferred to M3 when the /ops dashboard reads from Langfuse.
- Every error → chat:errors:YYYY-MM-DD with category and detail
- Successful chats log `[chat] rate ok ip: count:` to Vercel runtime logs
- Daily digest cron at 00:00 UTC summarizes the day, emails via Resend
- Spike alert: > 10 errors/hour → immediate email, 2-hour cooldown

### Tag taxonomy

Every trace can carry zero or more of these tags:

- `rate-limited` — IP rate limit hit (40/hour). Returns early, no LLM call.
- `injection-detected` — `detectInjection(q)` hit. Returns early, no LLM call.
- `streamed-error` — Streaming failed partway. Partial response preserved in trace.
- `canary-leak` — `detectOutputLeak(accumulated)` hit. Post-stream; redaction applied to log preview.
- `model-refused` — Heuristic match against refusal phrase templates from system prompt. Post-stream.

Precedence:

- `rate-limited` and `injection-detected` are exclusive (short-circuit return before any other tag can fire)
- `streamed-error`, `canary-leak`, `model-refused` can co-exist on the same trace

### Commit conventions

- Conventional commits: `type(scope): subject` (e.g. `feat(canary):`, `chore:`, `fix(test):`). Body explains the why and any known limitations.
- Never include `Co-Authored-By: Claude` or any AI co-author trailer. Trailers are human-only — applies on this repo and any other.

## RAG (M2.1-M2.4)

- File layout: `rag/chunking/` (contextual chunker), `rag/ingest/markdown.ts` (shared generic ingest pipeline) + per-source wrappers `experience.ts` / `resume.ts` + `all.ts` (default multi-source driver), `scripts/rag/` (CLI entry points: `ingest.ts`, `ingest-experience.ts`, `ingest-resume.ts`, `smoke-retrieval.ts`), `content/` (markdown corpora — currently `experience.md`, `resume.md`), `supabase/migrations/` (schema, grants, retrieval RPC), `api/_tools.ts` (Anthropic tool definitions + `executeTool` for the chat handler), `tests/rag/` (integration tests against the live DB).
- Env vars: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server-side, `sb_secret_*` format, authenticates as `service_role`), `SUPABASE_PUBLISHABLE_KEY` (client-side, `sb_publishable_*`), `VOYAGE_API_KEY`. All live in `.env.local`.
- Commands: `npm run ingest` (default — ingest every markdown source in `content/` in sequence), `npm run ingest:experience` / `npm run ingest:resume` (per-source debugging helpers, same pipeline), `npm run smoke:retrieval` (top-3 hybrid retrieval against a hardcoded query with attribution), `npm run test:integration` (hybrid retrieval contract tests against live DB + Voyage), `supabase db push` (apply pending migrations). `/api/chat` itself is now tool-aware — no new operator command, but the chat handler may make multiple Anthropic round-trips per turn when tools fire.
- Schema: single `chunks` table for all sources, keyed `(source, source_id, chunk_index)` unique; `content_hash` (SHA-256) drives ingest idempotency — unchanged content consumes zero Voyage tokens.
- Pattern: contextual chunking — every chunk is one H3 section prefixed by its parent H2 heading on the first line of `content`. Paragraph-split fallback fires for H3 sections >500 tokens.
- Embedding model: Voyage `voyage-3`, 1024 dims, asymmetric — `input_type='document'` at ingest, `input_type='query'` at retrieval. `voyageai@0.0.8` is pinned exactly (no `^`); SDK is pre-1.0, upgrades go through a manual smoke run.
- Retrieval: `match_chunks(query_embedding, query_text, match_count, source_filter)` RPC; semantic + BM25 hybrid via Reciprocal Rank Fusion (k=60, canonical equal-weight, Cormack et al. 2009). Rich return shape: `semantic_rank`, `bm25_rank`, `semantic_distance`, `bm25_score`, and the fused `score` per result; a null rank means that retriever didn't see the chunk in its top-20. Pre-fusion over-retrieve at top-20 per list; English FTS config matches the existing `tsv` generated column. Generalized on `source_filter` so M2.3 (resume) and M2.5 (READMEs) reuse it without new migrations. M2.6 Haiku reranker will read from this function's output.
- Wiring: `/api/chat` calls retrieval via Anthropic tool-use. Two source-scoped tools (`search_experience`, `search_resume`) defined in `api/_tools.ts` and exposed in the Anthropic request. Sonnet picks one or both per turn; the handler runs ONE client-facing streaming session per user turn that internally iterates rounds — text deltas stream immediately, tool_use blocks accumulate, then tools execute and a follow-up round continues on the same stream. Cap is 3 rounds per turn. Langfuse: one `sonnet-response` generation per Anthropic call, one `tool-execution` span per tool firing, plus trace metadata `rag_retrieved` / `rag_queries` / `rag_sources` / `rag_top_chunk_ids` for the M3 dashboard.
- Known: H2-preamble lines (`**Dates:** ...`, `**Tech stack:** ...`) are dropped by the chunker — they aren't inside any H3 section. Banked for M3 retrieval-data review.
- Known: Supabase free-tier auto-pauses after 7 days inactivity (~30s cold start on first request after pause).
- Known: service_role grants don't auto-apply on user-created tables under `sb_secret_*` keys (codified in `0002_chunks_grants.sql`).

## Guiding principle

Solve the problem, keep it simple. Right-size infrastructure to actual load. Over-engineering reads as a senior anti-pattern. The portfolio must demonstrate engineering judgment — including the judgment of NOT building elaborate machinery for traffic that doesn't exist.

Real metrics or nothing. Never ship a dashboard or analytics with placeholder numbers.

## Local working docs (gitignored, not in this repo)

- followups.md — priority queue: immediate work, deferred items, the major LLMOps platform spec (deferred, do not start until Phase 2 is done and the URL is being shared with real traffic).
- DESIGN.md — rationale and intent: stack reasoning, voice decisions, feedback received and its impact, deliberate deferrals.

These are the authoritative working docs. CLAUDE.md (this file) is the public, stable context.

## Diagnostic discipline (learned from this build)

- Diagnose before fixing. Multiple "bugs" turned out to be working-as-designed (rate limit + NAT sharing, "missing" chat logs in a different UTC date key).
- Test production behavior against production, not against vercel dev. Vercel platform features (rewrites, etc.) don't reliably emulate locally.
- Run shell snippets from files, not chat-pastes (paste corruption from smart quotes / non-breaking spaces is a real recurring failure mode).
