# tusharjayanti.io

[![Live](https://img.shields.io/badge/live-tusharjayanti.io-blue?style=flat-square)](https://tusharjayanti.io)
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
[![Upstash Redis](https://img.shields.io/badge/Upstash_Redis-00E9A3?style=flat&logo=upstash&logoColor=white)](https://upstash.com/)
[![Resend](https://img.shields.io/badge/Resend-000000?style=flat&logo=resend&logoColor=white)](https://resend.com/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)

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

**What this isn't:** there's no post-response check on the model's output. No LLM-as-judge, no hallucination scoring, no output-side canary scrubber. The model is _instructed_ not to emit the canary, but there's no programmatic guard before the stream reaches the client. Adding an output-side `String.includes(CANARY_TOKEN)` scrubber is a cheap improvement on the roadmap.

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

- `[ ]` **Agentic RAG over resume, project docs, and GitHub READMEs.**
  Tarvis currently answers from a static system prompt with role facts
  inlined. Tool-use-gated retrieval lets the model decide _whether_ to
  retrieve (cutting unnecessary searches) and lets the knowledge base
  grow without bloating the prompt.

- `[ ]` **Smart model routing.** A cheap Haiku classifier routes
  greetings to Haiku, standard questions to Sonnet, complex multi-step
  questions to Sonnet at higher budget. Real cost discipline at scale.

- `[ ]` **URL fetching via Anthropic tool use.** Right now Tarvis can't
  read a job description if you paste a URL. A real reviewer hit this
  while testing the site. Implementation: scoped tool use with a domain
  allowlist and SSRF protection.

### Bot defense

- `[ ]` **Cloudflare Turnstile to replace IP-based rate limiting.**
  The current limiter is correct but blunt. Shared NAT means household
  devices count against each other, and a determined script costs the
  same as a curious visitor. Turnstile separates humans from automation
  directly.

- `[ ]` **Output-side canary scrubber.** Input side checks for canary
  emission. Output side currently relies on the system prompt telling
  the model not to leak it. A `String.includes(CANARY_TOKEN)` check on
  the streaming response would close that gap programmatically.

### LLMOps

- `[ ]` **Deterministic eval suite with CI gate.** A small fast test
  set (~15 tests, regex/contains/word-count) that runs on every PR and
  blocks deploy on failure. "Do you have evals?" is a default AI-role
  interview question and a working CI gate is a better answer than a
  plan.

- `[ ]` **Langfuse tracing with per-span cost.** Per-call wrapper around
  the Anthropic SDK on free-tier Langfuse. Buys real vocabulary for
  the chat system: p50/p95 latency, per-component cost breakdown, error
  rates by call type. Replaces hand-rolled token counting.

### Recently shipped

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

## Contact

- **Site** — [tusharjayanti.io](https://tusharjayanti.io)
- **Email** — tj@tusharjayanti.io
- **LinkedIn** — [linkedin.com/in/tusharjayanti](https://linkedin.com/in/tusharjayanti)
- **GitHub** — [@tusharjayanti](https://github.com/tusharjayanti)

---

## License

MIT
