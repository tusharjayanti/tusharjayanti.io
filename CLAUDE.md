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
- api/ — Vercel Edge Functions (chat.ts, cron/digest.ts, \_kv, \_injection, \_resend, \_langfuse, \_compat, \_systemPrompt.txt + .ts)
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

- Langfuse Cloud (Tokyo / jp.cloud.langfuse.com) is the primary trace destination as of M1.1. Every `/api/chat` request emits one trace (`chat-turn`) with input, output, userId (ipHash), and tags (`rate-limited`, `injection-detected`, `canary-leak`). The Sonnet streaming call inside is one `generation` observation capturing model, input messages, output, token counts (input/output/total + cache_creation/cache_read), latency, time-to-first-token, and a prompt linkage to the Langfuse-registered version (M1.2 — see "System prompt" above).
- Edge runtime: `flushAt: 1` on the Langfuse client and an explicit `flushAsync()` at end of request — Edge has no persistent process to batch for. Langfuse failures are caught and logged; they never break user-facing chat.
- Existing Redis chat log continues in parallel — every chat still writes to chat:log:YYYY-MM-DD (rolling list, 30-day TTL). Cutover decision deferred to M3 when the /ops dashboard reads from Langfuse.
- Every error → chat:errors:YYYY-MM-DD with category and detail
- Successful chats log `[chat] rate ok ip: count:` to Vercel runtime logs
- Daily digest cron at 00:00 UTC summarizes the day, emails via Resend
- Spike alert: > 10 errors/hour → immediate email, 2-hour cooldown

### Commit conventions

- Conventional commits: `type(scope): subject` (e.g. `feat(canary):`, `chore:`, `fix(test):`). Body explains the why and any known limitations.
- Never include `Co-Authored-By: Claude` or any AI co-author trailer. Trailers are human-only — applies on this repo and any other.

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
