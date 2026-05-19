# Observability

Notes for me, not the README. The README explains _what_ ships. This
file explains how I think about the primitives so I can answer
"how does your observability work?" in an interview without hedging.

## What observability actually does here

For Tarvis, observability is one thing: every chat turn becomes a
structured record I can search, filter, and aggregate over. Not just
a log line. A record with shape — input, output, tokens, latency,
cost, tags, prompt version — that survives the request and is
queryable later without parsing strings.

The reason this matters for an AI system specifically: the failure
modes aren't HTTP-shaped. A 200 OK can still be a bad response. A
fast response can still be wrong. A cheap call can still be a
refusal that the user didn't want. "Did this work?" isn't a metric
the load balancer can answer. The observability layer is where that
question becomes answerable.

## The primitives

Langfuse models five things; I use four of them today.

### Trace

One per `/api/chat` request. The unit of "what happened in this
conversation turn." Has an input (`{ q }`), output (the accumulated
response text), userId (hashed IP for anonymization), and zero or
more tags. Everything inside a single request — the LLM call, any
future retrieval steps, any tool calls — lives as observations
inside the trace.

This is the right granularity. Not per-token. Not per-day. Per-turn.

### Generation

The LLM call itself. Lives inside the trace. Carries model name,
input messages, output, token counts (input, output, cache
creation, cache read), latency, time-to-first-token, and a link
to the prompt version that produced it.

Cost is auto-computed by Langfuse from `model` + token counts.
The prompt-cache distinction matters here: a cache-read token at
$0.30/MTok looks the same as an input token at $3.00/MTok in a
hand-rolled counter, but Langfuse separates them and prices them
correctly.

### Tag

A flat string on the trace. Five tags today:

- `rate-limited` and `injection-detected` are exclusive — they
  fire on short-circuit paths before the LLM call.
- `streamed-error`, `canary-leak`, `model-refused` are
  non-exclusive — they fire post-stream and can co-exist.

Tags are cheap and queryable. "How many refusals last week?" is
a filter, not a SQL query I have to write.

### Prompt

A registered, versioned artifact in Langfuse's prompt registry.
The system prompt lives there as `tarvis-system-prompt`. Each push
gets a SHA-256-prefix label (12 hex chars) over the
canary-normalized content — so the per-deploy canary rotation
doesn't generate noise versions, only real editorial edits do.

The trace's generation links to the version. When I change a
refusal phrase tomorrow, every trace from "today" still points at
the prompt that produced it. That's what makes A/B reasoning
about prompt changes possible.

### Score (not yet)

Schema is there; I don't write to it yet. Scores attach to
traces and can be numeric or categorical. M3's eval CI gate
writes them from offline evals. M4's online Haiku judge writes
them from live traffic. Today: unpopulated.

## Why Langfuse vs. roll-your-own

Short version: I had a hand-rolled Redis log writing per-turn
records. It worked. It also wouldn't scale to the questions I'd
actually want to answer six months from now (cost breakdown by
prompt version, tag-filtered cost distribution, comparing token
spend across model variants), without me writing a query layer.

Longer version is in [`docs/decisions/0001-observability-foundation.md`](decisions/0001-observability-foundation.md).

The Redis chat log still writes in parallel. It's the local audit
trail; Langfuse is the queryable one. Cutover decision deferred to
M3 when the `/ops` dashboard reads from Langfuse reliably.

## What this doesn't do yet

Not pretending. Honest gaps:

- **No dashboard.** Langfuse UI is the read interface. M3 ships
  `/ops` — custom dashboard with the views I actually want
  (cost-by-tag, latency p50/p95 per prompt version, refusal-rate
  drift). Until then I'm a Langfuse-UI user, same as anyone else
  hitting it.

- **No quality scores on live traces.** The `model-refused` tag is
  heuristic substring matching against the system prompt's
  refusal phrase templates plus a word-count guard. Cheap, bounded
  false-positive rate, misses paraphrased refusals. M4 replaces
  it with an LLM judge.

- **No closed loop from low-scored traces back to evals.** M5
  territory: low-scored traces become candidate eval cases that
  M3's gate runs on the next PR. Today the loop is open — I see
  problems in Langfuse but acting on them is manual.

- **No multi-turn context.** Each trace is one user message; no
  session linkage across traces. Once conversation history ships,
  I'll start writing `sessionId` and traces in a session will
  link visually.

## Operational notes

Stuff that matters for someone debugging this later.

**Edge runtime constraints.** Vercel Edge has no persistent
process — function instances are short-lived and don't outlive
the request meaningfully. So `flushAt: 1` on the Langfuse client
(flush every event immediately, no batching) and an explicit
`flushAsync()` in the finally block. If a batch were sitting in
memory at function suspend, those events die.

**Failure tolerance.** Every Langfuse SDK call sits inside
try/catch. If Langfuse is unreachable, the chat handler logs and
continues. The user-facing chat must never break because the
observability layer is having a bad day.

**Ingest lag.** Langfuse Cloud's Hobby tier has variable ingest
lag — traces visible in seconds on a good run, ~10 minutes on a
bad one. The v4 SDK's "Faster experience" preview eliminates
this; v3→v4 migration is in followups, banked until v4 reaches
feature parity or M2 RAG surfaces specific features I want
(better span hierarchy, OTel compat for tools).

**Cost computation.** Langfuse computes cost upstream from
model name + token counts, including the three prompt-cache
buckets (input, cache-creation, cache-read) priced separately.
For this to keep working when the model rotates: the model name
I send must match what Langfuse's pricing registry knows about.
`claude-sonnet-4-6` works today. If the next model is named
differently, watch for the cost column going to zero in the UI.

**Trace volume.** Hobby tier is generous but not infinite. At
real traffic levels I'll need to revisit whether every chat
becomes a trace, or whether I sample. Not a problem today —
volume is roughly "me testing" plus "occasional visitor."
