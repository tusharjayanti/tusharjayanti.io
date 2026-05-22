# tusharjayanti.io

[![Live](https://img.shields.io/badge/live-tusharjayanti.io-blue?style=flat-square)](https://tusharjayanti.io)
[![CI](https://github.com/tusharjayanti/tusharjayanti.io/actions/workflows/ci.yml/badge.svg)](https://github.com/tusharjayanti/tusharjayanti.io/actions/workflows/ci.yml)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-blueviolet?style=flat-square)](https://claude.ai/code)

> A terminal-style portfolio with an AI chat assistant, doubling as an LLMOps testbed.

---

<p align="center">
  <img src="docs/demo.gif" alt="tusharjayanti.io terminal autoplay" width="100%" />
</p>

---

[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Vercel Edge](https://img.shields.io/badge/Vercel_Edge-000000?style=flat&logo=vercel&logoColor=white)](https://vercel.com/)
[![Anthropic](https://img.shields.io/badge/Anthropic_Sonnet_4.6-191919?style=flat&logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![Langfuse](https://img.shields.io/badge/Langfuse-0F0F0F?style=flat&logo=langfuse&logoColor=white)](https://langfuse.com/)
[![Upstash Redis](https://img.shields.io/badge/Upstash_Redis-00E9A3?style=flat&logo=upstash&logoColor=white)](https://upstash.com/)
[![Resend](https://img.shields.io/badge/Resend-000000?style=flat&logo=resend&logoColor=white)](https://resend.com/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)

---

## What this is

A production LLMOps demo built around a real chat agent on Claude
Sonnet 4.6. M1 shipped Langfuse observability — every chat turn becomes
a structured, queryable trace with token, cost, and prompt-version
fidelity. M2 shipped agentic RAG over experience, resume, and project
READMEs, with a Haiku-based reranker, a no-match fabrication
guardrail, and a terminal-page ops snippet; eval gates and
closed-loop scoring land in M3+.

---

## The problem

Traditional resumes are static. They list technologies, roles, and achievements, but they rarely show how someone actually thinks, builds, or communicates as an engineer.
Most portfolio sites haven't fixed that. You get a polished landing page, a few animations, a timeline, maybe a PDF to download. It looks fine. It's also passive. Like a lot of backend engineers, I'd been meaning to build one for years and kept getting pulled back into systems, APIs, and infrastructure. The few times I started, it always ended up looking like everyone else's, so I'd drop it.

## The solution

A portfolio that reflects how I actually work. Terminal-first, conversational, backend-heavy, AI-native. Visitors can run cat disco to read about a role, ask Tarvis to walk through the distributed-consistency problem I solved at Transcend, or type help to see what's here. **The chat, the defense layers, the streaming, the logging. It's the proof, not the pitch.**

> If you'd rather scan a conventional CV, that's at /cv. Same content, different rendering.

PS: yes, Tarvis == Tushar + Jarvis. I'm an Iron Man nerd, deal with it.

### What's built today:

- **Chat endpoint** with NDJSON streaming, structured logging, daily
  digest cron, and error-spike alerts on Resend.
- **Layered prompt-injection defense** — length cap, rate limit, regex
  prefilter with canary scan, system-prompt rules, response-length cap.
  Five layers, in code, not just in the system prompt.
- **Terminal interface** with autoplay welcome, Unix-style command
  dispatch (`whoami`, `cat <role>`, `help`), and chat invocation.
- **Schema-driven content** — one data source feeds both terminal
  `cat <role>` and the structured `/cv` page.
- **Output-side canary scrubber and leak alerting** — post-stream substring
  check on the model's response. On hit, redacts the canary in the log
  preview and fires an immediate email via Resend, with leak events
  persisted to Redis. Per-deploy canary rotation makes a leaked token
  stale on next push.
- **Langfuse observability** — every chat turn traces to Langfuse Cloud
  (Tokyo region): input, output, model, token counts (including prompt
  cache reads/writes), latency, TTFT, cost. Five-tag taxonomy classifies
  trace behavior. System prompt is registered and versioned in Langfuse's
  prompt registry, with traces linked to the prompt version that
  produced them.

---

## Architecture

The chat request path, end to end:

```
  POST /api/chat
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 1: shape + length              method=POST,           │
  │                                        q ∈ string,           │
  │                                        len ≤ 500             │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 2: rate limit                  Upstash Redis,         │
  │                                        40/hr/IP hash         │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 3: injection prefilter         canary scan first,     │
  │                                        then 7 regex patterns │
  │                                        (no tokens spent)     │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Anthropic Sonnet 4.6                  system: _systemPrompt │
  │   ├─ Layer 4: system-prompt rules      max_tokens: 1024      │
  │   └─ Layer 5: response cap                                   │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  NDJSON streaming → client            { type: 'delta', text }│
  │                                        emitted per token     │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Fire-and-forget: logChatTurn          ipHash, q,            │
  │  → Upstash Redis                       aPreview (280 chars), │
  │                                        timestamp             │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Daily cron → digest email             Resend, 00:00 UTC,    │
  │                                        spike alerts on error│
  └──────────────────────────────────────────────────────────────┘
```

### Key files

| File                    | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `api/chat.ts`           | Edge function. Orchestrates the layers, calls Anthropic, streams NDJSON, logs the turn. |
| `api/_injection.ts`     | Regex prefilter + canary scan. 7 patterns, first-match-wins.                            |
| `api/_systemPrompt.txt` | Source of truth for Tarvis's identity, role facts, and behavioral defense rules.        |
| `api/_systemPrompt.ts`  | Generated from `.txt` by `scripts/sync-prompt.mjs`. Imported by the edge function.      |
| `api/_kv.ts`            | Upstash bindings, rate-limit counter, chat-turn logging.                                |
| `api/cron/digest.ts`    | Daily Resend email of chat activity, plus spike-alert trigger.                          |
| `src/modes/terminal/`   | Terminal UI, command dispatch, autoplay.                                                |
| `src/modes/cv/`         | CV rendering of the same content layer.                                                 |

---

## Defense

Five layers in the request path, in order of execution:

| Layer                      | Where                                   | What it does                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Length cap (500 chars)     | `api/chat.ts` shape validation          | Bounds prompt size. Cost cap + blast-radius cap.                                                                                                                                                                                                                                        |
| Rate limit (40/hr/IP)      | `api/_kv.ts` `checkRateLimit`           | Hour-bucketed per-IP-hash counter on Upstash. Blocks abuse without leaking raw IPs to storage.                                                                                                                                                                                          |
| Injection prefilter        | `api/_injection.ts` `detectInjection`   | Canary scan first (literal token match = high-signal, zero false-positive), then 7 regex patterns (override-instructions, prompt-extraction, DAN, jailbreak, developer-mode, role-hijack). First match wins. Refuses with `REFUSAL_TEXT` without calling Anthropic — zero tokens spent. |
| System-prompt rules        | `api/_systemPrompt.txt` Defense section | Behavioral layer for paraphrased attacks the regex can't catch. Refuses to reveal the prompt or the canary, refuses role hijacks, refuses off-topic with one-line wit and redirect.                                                                                                     |
| Response cap (1024 tokens) | `max_tokens` on the Anthropic call      | Stops the model mid-generation regardless of what it was about to say. Bounds exfiltration size.                                                                                                                                                                                        |

**Explicit design choice:** layer 3 is cheap regex, not LLM-based classification. Trivially bypassable by paraphrase (`ign0re previous` slips through). That's intentional — cheap layer 1 catches the loud attacks for free, behavioral layer 2 catches the subtle ones at API cost. Better than nothing, honest about its bypass surface.

**What this isn't (still):** there's no LLM-as-judge for hallucination
scoring on the response, and no detection of paraphrased prompt
extraction (the model summarizing the system prompt without emitting
the canary verbatim). The output-side canary scrubber shipped in Phase
0.1 — see "What's built today." LLM-judge quality scoring is deferred
to M5 (online Haiku scoring via `waitUntil`).

---

## Cost optimization

### Prompt caching

Tarvis sends the same ~3,800 token system prompt on every chat turn.
Without caching, every turn pays full input price on those tokens.
With prompt caching, Anthropic holds the precomputed K/V matrices for
the system prompt in memory for 5 minutes and reuses them. Same
output, lower price.

The mechanism is one line: `cache_control: { type: 'ephemeral' }` on
the system content block. Token instrumentation captures the
behavior in the Redis log.

#### Three input-token buckets

| Bucket                        | What it means                           | Rate (per MTok) |
| ----------------------------- | --------------------------------------- | --------------- |
| `input_tokens`                | Tokens processed fresh, not cached      | $3.00           |
| `cache_creation_input_tokens` | Tokens written to cache (1.25x premium) | $3.75           |
| `cache_read_input_tokens`     | Tokens read from cache (10x discount)   | $0.30           |

Sonnet 4.6 pricing at the time of writing.

#### What the log shows

Two consecutive chat turns from local verification, 2:41 apart:

**Turn 1 — `"Tell me about vox-agent."`** — cache miss, write:

```
"tokens_in": 14, "cache_creation_tokens": 3848, "latency_ms": 6661
```

**Turn 2 — `"What was the DISCO authn migration about?"`** — cache hit, read:

```
"tokens_in": 16, "cache_read_tokens": 3848, "latency_ms": 7073
```

Turn 1 wrote the system prompt to cache. Turn 2 read it back.
`tokens_in` stays tiny on both turns because the system prompt is
no longer in the "uncached" bucket — it's been sorted into one of
the cache buckets.

#### Cost numbers

|                 | Turn 1   | Turn 2   | Total    |
| --------------- | -------- | -------- | -------- |
| Without caching | $0.01159 | $0.01159 | $0.02318 |
| With caching    | $0.01447 | $0.00120 | $0.01567 |
| Delta           | +24.8%   | −89.6%   | −32.4%   |

Turn 1 costs slightly more — the 25% write premium. Turn 2 costs
~90% less. Breakeven is one third of a single cache reuse; any
chatty visitor puts caching net-positive immediately. For a
visitor asking 5 questions in 2 minutes (the modal pattern):
$0.058 → $0.019, ~67% saved on input cost.

#### What this doesn't do

- **Output tokens unchanged.** Caching only discounts input.
- **5-minute TTL is deliberate.** Anthropic also offers 1-hour TTL
  at 2x base input on writes (vs. 1.25x). Tarvis's bursty pattern —
  a visitor asks several questions in 2 minutes, then nothing for
  hours — fits 5-minute well. Re-examine once production traffic
  shows whether visitors return within the 6-60 minute window.
- **One cache breakpoint.** Larger context (tools, RAG, conversation
  history) would have more layers to cache. Tarvis is single-turn,
  no tools today.

---

## Observability

Every chat turn becomes a structured trace in Langfuse Cloud (Tokyo
region). One trace per `/api/chat` request, one generation observation
inside it for the Sonnet streaming call. The structure scales for M2 RAG
— when retrieval + rerank steps ship, they become sibling observations
inside the same trace.

### What's captured per trace

| Dimension                  | Where it lives                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| Input (the user's `q`)     | trace input                                                             |
| Output (the response text) | trace output                                                            |
| User ID                    | anonymized `ipHash` (SHA-256 prefix)                                    |
| Model                      | `claude-sonnet-4-6`                                                     |
| Token counts               | input, output, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Cost                       | auto-computed by Langfuse from model pricing                            |
| Latency                    | generation latency + total trace duration                               |
| Time-to-first-token        | server-side measurement of first stream chunk                           |
| Metadata                   | userAgent, geoCountry (from Vercel Edge)                                |

### Tag taxonomy

Five tags classify trace behavior. Tags 1–2 are exclusive (short-circuit
returns); tags 3–5 can co-exist.

| Tag                  | Fires when                                                   |
| -------------------- | ------------------------------------------------------------ |
| `rate-limited`       | IP rate limit hit, no LLM call                               |
| `injection-detected` | Regex prefilter caught injection, no LLM call                |
| `streamed-error`     | Stream failed partway through generation                     |
| `canary-leak`        | Output contained the system prompt's canary token            |
| `model-refused`      | Model declined (heuristic match on refusal phrase templates) |

### Prompt versioning

The system prompt is registered in Langfuse's prompt registry as
`tarvis-system-prompt`. Version label is a SHA-256 prefix (12 hex chars)
of the prompt content with the per-deploy canary normalized — so canary
rotation doesn't generate noise versions, only real editorial edits do.

Each trace's generation links to the version that produced it.

### What this isn't (yet)

- The terminal-page ops snippet exposes a minimal public observability
  surface (visitor count, queries, tokens, tools/turn, last-aggregated
  timestamp). Full `/ops` dashboard is M4 — private, basic-auth-gated,
  expands the same data sources with per-tool breakdown, cost split,
  latency percentiles, retrieval eval results, and a recent-queries
  tail. Langfuse UI remains the read interface for deep trace
  inspection.
- No quality scoring on traces — `score` is part of the schema but
  unpopulated. M5 (online Haiku scoring) and M3 (eval CI gate) write
  scores.
- Trace updates (output text, post-stream tags) intermittently fail to
  land in Langfuse Cloud due to a known v3 SDK bug on Edge runtime where
  waitUntil-wrapped flushAsync() can return before all events flush
  (langfuse/langfuse#5843). The trace and generation observation always
  land; the post-stream trace.update({ output, tags }) may not.
  Verified empirically during M1.3 development. Three of five tags
  (rate-limited, injection-detected, canary-leak) land reliably
  because they're pushed earlier in the request lifecycle; two
  (model-refused, streamed-error) are post-stream and hit the bug
  more often. The v4 OTel-based SDK eliminates this — migration tracked
  in followups.md.
- No closed loop from low-scored traces to auto-generated eval cases —
  M6 territory.
- The existing Redis chat log keeps writing in parallel. Cutover happens
  when M4's dashboard reads from Langfuse reliably.

### Operational notes

Langfuse failures are caught and logged; they never break user-facing
chat. Trace writes use `flushAt: 1` and an explicit `flushAsync()` in
the finally block — Edge runtime has no persistent process to batch for.
Langfuse Cloud's Hobby tier has variable ingest lag (sub-second to ~10
minutes). The v4 SDK eliminates this; v3→v4 migration is banked in
followups.

---

## Roadmap

This portfolio is also a working LLMOps demo. The chat assistant (Tarvis)
runs on a real Anthropic API integration, not a mock, and the items below
are the next things being built on top of that foundation. Each item
explains _why_ it's on the list.

Status legend: `[ ]` queued, `[~]` in progress, `[x]` shipped.

### Chat / LLM

- `[x]` **Anthropic prompt caching on the system prompt.** Shipped — see
  [Cost optimization](#cost-optimization) for the mechanism, the
  three-bucket token breakdown, and measured numbers from production.

- `[ ]` **Smart model routing.** A cheap Haiku classifier routes
  greetings to Haiku, standard questions to Sonnet, complex multi-step
  questions to Sonnet at higher budget. Real cost discipline at scale.

### Bot defense

- `[ ]` **Cloudflare Turnstile to replace IP-based rate limiting.**
  The current limiter is correct but blunt. Shared NAT means household
  devices count against each other, and a determined script costs the
  same as a curious visitor. Turnstile separates humans from automation
  directly.

### LLMOps

- `[ ]` **Deterministic eval suite with CI gate.** A small fast test
  set (~15 tests, regex/contains/word-count) that runs on every PR and
  blocks deploy on failure. "Do you have evals?" is a default AI-role
  interview question and a working CI gate is a better answer than a
  plan.

- `[x]` **Langfuse tracing with per-span cost.** Shipped in M1 — see
  [Observability](#observability) for the trace structure, tag
  taxonomy, and prompt versioning details. Prompt-cache token math
  surfaces correctly in Langfuse's cost display.

### Recently shipped

- `[x]` **M2 — agentic RAG with hybrid retrieval, reranker, and ops
  snippet.** Tool-use-gated retrieval over experience / resume /
  READMEs, semantic + BM25 hybrid with RRF, Haiku 4.5 listwise
  reranker (with verdict-based out-of-corpus detection), no-match
  fabrication guardrail, `fetch_url` tool with SSRF protection,
  retrieval eval harness (31 labeled queries, retrieval@5 84.6%),
  terminal-page ops snippet with hashed-IP visitor counter and
  Langfuse-sourced metrics. v0.3.0. Sub-milestone breakdown in
  [`docs/rag.md`](docs/rag.md).
- `[x]` **M1 — Langfuse observability foundation.** Trace/generation/tag
  taxonomy, prompt versioning, cost computation. v0.2.0.
- `[x]` **Phase 0.2 — Canary rotation and leak alerting.** Per-deploy
  rotation via `sync-prompt.mjs`, leak event persistence in Redis,
  synchronous email alerting via Resend on detection.
- `[x]` **Phase 0.1 — Output canary scrubber.** Post-stream substring
  check on the model's response, with redaction in the log preview.
- `[x]` Phase 2: real CV content in resume-register voice, schema
  migration to support grouped bullets, inline markdown bold parser,
  system prompt rewrite with role-specific facts, terminal whoami
  autoplay.
- `[x]` Tarvis chat endpoint: NDJSON streaming, input-side regex
  prefilter and canary check, voice-consistent error handling,
  shrug-thread signature.
- `[x]` SPA routing fix on Vercel (see "Deliberate decisions" below
  for the rationale).
- `[x]` IP-based rate limiting (40/hr, hour-bucketed) and daily
  digest cron with error-spike alerts.

### What's not on this list, deliberately

- A full real-time LLMOps platform with ClickHouse, Kafka, and ML-based
  bot scoring. Real ambition, but premature here. The site has near-zero
  traffic; building production-grade telemetry infrastructure for that
  reads as over-engineering, not vision. Defers until traffic is real.
- Voice mode and other flashy integrations. Demo-flash without
  interview signal.
- Conversation history / multi-turn context. Useful, but only after
  retrieval and eval foundations are in. Not load-bearing on its own.

The list above is what's actually next, in roughly the order it'll
happen. It updates as items ship.

---

## Deliberate decisions

Engineering rationale for the non-obvious choices.

<!--
  As features ship, add new subsections here matching the SPA pattern:
  - "### Prompt caching — content-block over string-form system prompt"
  - "### URL handling — why tool_use over a regex fetcher"
  - "### Eval CI gate — why deterministic over LLM-as-judge"
  Each section: one-line context → the decision → tradeoff → debugging note.
-->

### SPA routing — rewrite in committed `vercel.json`

**The decision.** The SPA rewrite that makes `/terminal` and `/cv` work
on hard-refresh lives directly in `vercel.json`:

```json
{ "source": "/((?!api/|.*\\.).+)", "destination": "/index.html" }
```

Dot-exclusion regex. Skips `/api/*` and any path with a dot (assets,
Vite dev modules). Serves `index.html` for dot-free non-API paths.

**Why not build-time injection.** Tried that (injecting the rewrite
inside `vercel-build`). It doesn't work: Vercel reads `vercel.json`
_before_ running the build script, so the injection is always too
late. Don't reintroduce it.

**The tradeoff.** `vercel dev` reads the same `vercel.json` locally and
the rewrite catches Vite's on-demand dev modules (`/src/main.tsx`,
`/@vite/client`), crashing the dev server with "invalid JS syntax at
index.html." So local dev is split: `npm run dev` (Vite, port 5173)
for frontend, `npm run dev:edge` (Vercel dev, port 3000) for `/api/*`
curl testing only.

**Known limitation.** Routes with a dot in the path (`/v1.2/changelog`)
won't be rewritten. Keep route paths dot-free.

**If `/terminal` is 404ing in production:** check that `vercel.json`
still has the `rewrites` block. That's almost always the bug.

---

## Stack

- Vite + React 19 + TypeScript on the frontend.
- Vercel Edge Functions for `/api/*`.
- Upstash Redis (Mumbai) — chat logs, error logs, rate-limit counters.
- Langfuse Cloud (Tokyo) — primary trace destination.
- Resend (Tokyo) — outbound mail (daily digest, spike alerts).
- Supabase Postgres + pgvector — RAG storage.
- Voyage `voyage-3` embeddings (1024 dims, asymmetric).
- Anthropic Claude Sonnet 4.6 for chat; Haiku 4.5 planned for evals and reranking.

## Status

- **M1** (observability foundation) — shipped at `v0.2.0`. Langfuse tracing, prompt versioning, cost computation. Details in [`docs/observability.md`](docs/observability.md), rationale in [`docs/decisions/0001-observability-foundation.md`](docs/decisions/0001-observability-foundation.md).
- **M2** (agentic RAG + observability surface) — shipped at `v0.3.0`. Hybrid retrieval (semantic + BM25), Haiku reranker, multi-source ingest (experience, resume, READMEs), tool-use integration, no-match guardrail, `fetch_url` tool, eval harness, terminal-page ops snippet. Details in [`docs/rag.md`](docs/rag.md), rationale in [`docs/decisions/0002-agentic-rag.md`](docs/decisions/0002-agentic-rag.md).
- **M3–M6** — roadmap. Eval CI gate, `/ops` dashboard, online Haiku scoring, closed-loop eval generation.

---

## Contact

- **Site** — [tusharjayanti.io](https://tusharjayanti.io)
- **Email** — tj@tusharjayanti.io
- **LinkedIn** — [linkedin.com/in/tusharjayanti](https://linkedin.com/in/tusharjayanti)
- **GitHub** — [@tusharjayanti](https://github.com/tusharjayanti)

---

## License

MIT
