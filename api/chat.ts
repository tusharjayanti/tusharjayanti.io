import Anthropic from '@anthropic-ai/sdk';
import type {
  Langfuse,
  LangfuseGenerationClient,
  LangfuseTraceClient,
} from 'langfuse';
import {
  CANARY_TOKEN,
  PROMPT_NAME,
  PROMPT_VERSION_NUMBER,
  systemPrompt,
} from './_systemPrompt.js';
import { detectInjection, detectOutputLeak } from './_injection.js';
import { detectRefusal } from './_refusal.js';
import {
  checkRateLimit,
  getHourlyErrorCount,
  hashIp,
  logChatError,
  logChatTurn,
  recordLeakEvent,
  shouldSendSpikeAlert,
  updateLeakLastAlertedAt,
} from './_kv.js';
import {
  getHeader,
  parseBody,
  writeResponse,
  type CompatRequest,
} from './_compat.js';
import { getLangfuse, makeSystemPromptHandle } from './_langfuse.js';
import { TOOLS, executeTool, isToolName } from './_tools.js';

export const runtime = 'edge';

// Raised from 500 to 50,000 so users can paste a full JD or article
// inline without hitting the validation wall. 50K chars ≈ 12.5K
// tokens — well within Sonnet's context budget alongside the system
// prompt and any retrieved chunks. The chat handler also has a
// `fetch_url` tool for cases where the user pastes a link instead.
const MAX_Q_LENGTH = 50_000;
const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
// Cap on tool-use rounds per turn. 3 rounds = initial + 2 tool follow-ups,
// which is more than Sonnet ever needs for the two RAG tools and guards
// against runaway loops if a future tool returns ambiguous results.
const MAX_TOOL_ROUNDS = 3;

const REFUSAL_TEXT = 'Not how this works. Want to know what I built at DISCO?';
const RATE_LIMIT_TEXT =
  "You've hit the chat limit for this hour. Try again in a bit, or drop me an email at tj@tusharjayanti.io.";

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const encoder = new TextEncoder();

function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  obj: unknown,
) {
  controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
}

async function fireAndForget(
  resOrCtx: unknown,
  promise: Promise<unknown>,
): Promise<void> {
  const ctx = resOrCtx as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined;
  if (typeof ctx?.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  // No waitUntil (vercel dev) — await inline so the log write completes before
  // the handler exits and the function process is reaped.
  await promise.catch(() => undefined);
}

// Update trace with final tags + output + RAG metadata, then drain
// the SDK. `shutdownAsync` is the right call on Vercel (not
// `flushAsync` alone): it clears the periodic flush timer, calls
// flushAsync to push the queue, awaits the in-flight
// `pendingIngestionPromises` (the actual HTTP round-trips — this is
// the bit `flushAsync` alone doesn't wait for on Vercel's tight
// termination window), then flushes any events that arrived during
// the wait. Wrapped in try-catch so Langfuse failures never break
// user-facing chat.
//
// Singleton lifecycle: shutdownAsync doesn't invalidate the client's
// send methods, only stops the periodic timer. Combined with our
// `flushAt: 1` config (every event triggers a flush regardless), a
// warm-reused function instance still ingests correctly on the next
// request.
async function finalizeTrace(
  lf: Langfuse | null,
  trace: LangfuseTraceClient | null,
  tags: string[],
  output: string,
  ragMeta: RagTraceMetadata,
): Promise<void> {
  if (!lf || !trace) return;
  try {
    trace.update({
      output,
      tags,
      metadata: {
        rag_retrieved: ragMeta.rag_retrieved,
        rag_queries: ragMeta.rag_queries,
        rag_sources: ragMeta.rag_sources,
        rag_top_chunk_ids: ragMeta.rag_top_chunk_ids,
        rag_no_match: ragMeta.rag_no_match,
      },
    });
    await lf.shutdownAsync();
  } catch (err) {
    console.error('[langfuse] trace finalize failed:', err);
  }
}

// Record a canary leak to Redis and fire the first alert email. On Resend
// failure, reset the entry's lastAlertedAt to 0 so the next cron tick re-
// alerts instead of waiting 60min from the (failed) initial send.
async function recordAndAlertLeak(
  req: CompatRequest,
  ipHash: string,
): Promise<void> {
  const event = {
    canary: CANARY_TOKEN,
    ipHash,
    userAgent: (getHeader(req, 'user-agent') ?? '').slice(0, 200),
    geoCountry: getHeader(req, 'x-vercel-ip-country') ?? null,
  };
  const entry = await recordLeakEvent(event);
  try {
    const { sendLeakAlert } = await import('./_resend.js');
    await sendLeakAlert({
      ts: entry.ts,
      leakedCanary: entry.canary,
      currentCanary: CANARY_TOKEN,
      ipHash: entry.ipHash,
      userAgent: entry.userAgent,
      geoCountry: entry.geoCountry,
    });
  } catch (err) {
    console.error(
      '[chat] leak alert send failed; queuing for cron retry:',
      err,
    );
    await updateLeakLastAlertedAt(entry, 0);
  }
}

// After any chat error: bump the hourly counter and — if we've crossed the
// threshold AND no alert has fired this hour — send a real-time spike alert
// via Resend. Dynamic-imports `_resend` so the cold-start path doesn't pay
// the cost when no errors occur.
function checkAndSendSpike(resOrCtx: unknown): void {
  fireAndForget(
    resOrCtx,
    (async () => {
      const errorCount = await getHourlyErrorCount();
      if (errorCount < 10) return;
      if (!(await shouldSendSpikeAlert())) return;
      const { sendEmail } = await import('./_resend.js');
      await sendEmail({
        subject: `tusharjayanti.io ALERT — error spike (${errorCount} errors this hour)`,
        text:
          `Error count for the current hour has exceeded 10 (currently at ${errorCount}).\n\n` +
          `Check Upstash chat:errors:${new Date().toISOString().slice(0, 10)} for details.\n\n` +
          `Check Vercel logs for context.\n\n` +
          `This is the first alert this hour — cooldown active for 2 hours.`,
      });
    })(),
  );
}

// Per-tool-use block accumulator. JSON arrives as `input_json_delta`
// fragments inside content_block_delta events; we concatenate them and
// JSON.parse at content_block_stop. `id` and `name` come from the
// content_block_start event for the block.
type ToolUseAccum = {
  id: string;
  name: string;
  jsonBuffer: string;
};

// Result of one Anthropic streaming round. Encodes the content blocks
// in the assistant message (used to reconstruct conversation history),
// the stop_reason, and per-call usage.
type StreamRoundResult = {
  contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stopReason: string | null;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model?: string;
  // This round's Langfuse generation, so the caller can parent each
  // round's tool-execution spans to the generation that actually emitted
  // the tool_use blocks (round 0 for parallel turns, the current round for
  // sequential ones) rather than always round 0.
  generation: LangfuseGenerationClient | null;
};

type RagTraceMetadata = {
  rag_retrieved: boolean;
  rag_queries: string[];
  rag_sources: string[];
  rag_top_chunk_ids: string[];
  rag_no_match: boolean;
};

export default async function handler(
  req: CompatRequest,
  resOrCtx?: unknown,
): Promise<Response | void> {
  if (req.method !== 'POST') {
    return writeResponse(
      resOrCtx,
      new Response(JSON.stringify({ error: 'method not allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  // (a) body validation
  const parsed = (await parseBody(req)) as { q?: unknown } | null;
  const q = typeof parsed?.q === 'string' ? parsed.q : '';
  if (q.length === 0 || q.length > MAX_Q_LENGTH) {
    fireAndForget(
      resOrCtx,
      logChatError({
        ipHash: 'unhashed',
        q,
        category: 'validation',
        detail: `q length: ${q.length}, parsed: ${JSON.stringify(parsed).slice(0, 100)}`,
      }),
    );
    checkAndSendSpike(resOrCtx);
    return writeResponse(
      resOrCtx,
      new Response(
        JSON.stringify({
          error:
            q.length === 0
              ? 'expected { q: string } with 1..50,000 chars'
              : 'Message exceeds 50,000 character limit. Please summarize the key parts or paste a relevant section.',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
  }

  // (b) ip hash
  const ipHash = await hashIp(req);

  // (b.1) Langfuse trace — created here so every post-validation branch can
  // attach tags / output. Tags are accumulated locally and applied once at
  // the end via finalizeTrace (Langfuse trace.update replaces the tags array
  // rather than appending, so we set them in one call).
  const lf = getLangfuse();
  const tags: string[] = [];
  const ragMeta: RagTraceMetadata = {
    rag_retrieved: false,
    rag_queries: [],
    rag_sources: [],
    rag_top_chunk_ids: [],
    rag_no_match: false,
  };
  let trace: LangfuseTraceClient | null = null;
  try {
    if (lf) {
      trace = lf.trace({
        name: 'chat-turn',
        userId: ipHash,
        input: { q },
        metadata: {
          geoCountry: getHeader(req, 'x-vercel-ip-country') ?? null,
          userAgent: (getHeader(req, 'user-agent') ?? '').slice(0, 200) || null,
        },
      });
    }
  } catch (err) {
    console.error('[langfuse] trace creation failed:', err);
  }

  // (b.2) Eval-bypass: skip rate-limiting for trusted eval-runner
  // traffic. The X-Eval-Bypass header carries the shared secret
  // (compared constant-time against EVAL_BYPASS_SECRET). Fail-closed:
  // if the env var is unset, ALL inbound bypass headers are rejected
  // and the request goes through the normal rate-limit path.
  //
  // CRITICAL: the bypass skips rate-limiting ONLY. The injection
  // regex below (api/_injection.ts) is part of the defense being
  // tested by the eval; it runs unchanged for eval traffic. Any
  // future refactor that widens the bypass to skip the injection
  // check would invalidate the injection-category eval coverage —
  // don't.
  const evalBypassHeader = getHeader(req, 'x-eval-bypass');
  const evalBypassSecret = process.env.EVAL_BYPASS_SECRET;
  let isEvalRequest = false;
  if (
    evalBypassSecret &&
    typeof evalBypassHeader === 'string' &&
    evalBypassHeader.length === evalBypassSecret.length
  ) {
    let acc = 0;
    for (let i = 0; i < evalBypassHeader.length; i++) {
      acc |= evalBypassHeader.charCodeAt(i) ^ evalBypassSecret.charCodeAt(i);
    }
    if (acc === 0) {
      isEvalRequest = true;
    }
  }
  if (isEvalRequest) {
    tags.push('eval-source');
    const evalQueryId = getHeader(req, 'x-eval-query-id');
    if (typeof evalQueryId === 'string' && evalQueryId.length > 0) {
      try {
        trace?.update({ metadata: { eval_query_id: evalQueryId } });
      } catch (err) {
        console.error('[langfuse] trace eval-query-id update failed:', err);
      }
    }
  }
  const traceId: string | null = trace?.id ?? null;

  // (c) rate limit. Eval-source requests skip this branch entirely
  // (see (b.2)); they still increment the counter (no special
  // skip-incr API exists in checkRateLimit) but the limit gate
  // does not apply to them.
  const { ok, count } = await checkRateLimit(ipHash);
  if (!ok && !isEvalRequest) {
    console.warn(
      '[chat] rate limit exceeded for ip:',
      ipHash.slice(0, 8),
      'count:',
      count,
    );
    fireAndForget(
      resOrCtx,
      logChatError({
        ipHash,
        q,
        category: 'rate-limit',
        detail: `count: ${count}, window: 1 hour, limit: 40`,
      }),
    );
    checkAndSendSpike(resOrCtx);
    tags.push('rate-limited');
    // Direct await (no fireAndForget/waitUntil) so the Langfuse SDK's
    // pending HTTP ingestions finish before Vercel reclaims the
    // function. The user has already taken their hit on the 429 path;
    // the extra ~200ms of function uptime is invisible to them.
    await finalizeTrace(lf, trace, tags, RATE_LIMIT_TEXT, ragMeta);
    const body =
      JSON.stringify({ type: 'error', message: RATE_LIMIT_TEXT }) +
      '\n' +
      JSON.stringify({ type: 'done' }) +
      '\n';
    return writeResponse(
      resOrCtx,
      new Response(body, { status: 429, headers: NDJSON_HEADERS }),
    );
  }
  console.log('[chat] rate ok ip:', ipHash.slice(0, 8), 'count:', count);

  // (d) injection guard
  const inj = detectInjection(q);
  if (inj.hit) {
    console.warn('[chat] injection probe detected:', {
      reason: inj.reason,
      qPreview: q.slice(0, 100),
    });
    tags.push('injection-detected');
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Stream-event protocol additions for eval consumers (Phase 4a):
        //   trace (first, before any delta) — exposes trace_id for the
        //     runner to store in PerQueryResultEntry.trace_id
        //   rag    (after content, before done) — surfaces rag_used +
        //     sources for source_includes / source_excludes assertions
        //   usage  (after content, before done) — surfaces token counts
        //     so the runner computes cost USD from its price table
        // This path doesn't call the LLM (regex short-circuited), so
        // rag_used is false and token counts are zero. The events still
        // fire so the eval runner sees a uniform protocol on every path.
        emit(controller, { type: 'trace', traceId });
        emit(controller, { type: 'delta', text: REFUSAL_TEXT });
        emit(controller, {
          type: 'rag',
          rag_used: false,
          sources: [],
        });
        emit(controller, {
          type: 'usage',
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          model: null,
        });
        emit(controller, { type: 'done' });
        await fireAndForget(
          resOrCtx,
          logChatTurn({ ipHash, q, aPreview: REFUSAL_TEXT }).catch((err) => {
            console.error('[chat] chat log write failed:', err);
          }),
        );
        await finalizeTrace(lf, trace, tags, REFUSAL_TEXT, ragMeta);
        controller.close();
      },
    });
    return writeResponse(
      resOrCtx,
      new Response(stream, { headers: NDJSON_HEADERS }),
    );
  }

  // (e) Anthropic — single client streaming session that may span multiple
  // Anthropic round-trips if Sonnet emits tool_use blocks. The outer
  // ReadableStream is the user-facing channel; inside, we iterate rounds
  // until Sonnet returns end_turn (or we hit MAX_TOOL_ROUNDS).
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  type Message = Anthropic.Messages.MessageParam;
  const messages: Message[] = [{ role: 'user', content: q }];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Stream-event protocol additions for eval consumers (Phase 4a):
      //   trace (first, before any delta) — exposes trace_id for the
      //     runner to store in PerQueryResultEntry.trace_id
      //   rag    (after content, before done) — surfaces rag_used +
      //     sources for source_includes / source_excludes assertions
      //   usage  (after content, before done) — surfaces token counts
      //     so the runner computes cost USD from its price table
      // Emitted on every terminal branch (success done at line below;
      // error-in-stream done a few lines down) so the eval runner
      // never has to handle a missing event.
      emit(controller, { type: 'trace', traceId });

      let accumulated = '';
      let totalTokensIn: number | undefined;
      let totalTokensOut: number | undefined;
      let totalCacheCreationTokens: number | undefined;
      let totalCacheReadTokens: number | undefined;
      let model: string | undefined;
      let firstTokenAt: number | null = null;
      const startMs = Date.now();

      // Per-round helper. Runs one Anthropic streaming call, streams text
      // deltas to the client (preserving the no-tool TTFT), and returns the
      // structured assistant message + usage. Each round opens its own
      // Langfuse generation so cost/token breakdown survives multi-call turns.
      async function runRound(roundIndex: number): Promise<StreamRoundResult> {
        const promptHandle = makeSystemPromptHandle(
          PROMPT_NAME,
          PROMPT_VERSION_NUMBER,
        );
        let generation: LangfuseGenerationClient | null = null;
        try {
          // Snapshot messages — the array is mutated as the turn progresses
          // (assistant content blocks + tool_result blocks appended each
          // round), so Langfuse must see the input state at THIS call's
          // moment, not the final array.
          const inputSnapshot = JSON.parse(JSON.stringify(messages));
          // Per the trace taxonomy: round 0 is the call that may produce
          // tool_use ("anthropic_first_call"); rounds 1+ are the follow-up
          // responses after tool_results land ("anthropic_second_call").
          const generationName =
            roundIndex === 0 ? 'anthropic_first_call' : 'anthropic_second_call';
          generation =
            trace?.generation({
              name: generationName,
              model: MODEL_ID,
              modelParameters: { max_tokens: MAX_TOKENS },
              input: inputSnapshot,
              startTime: new Date(),
              metadata: { round: roundIndex },
              ...(promptHandle ? { prompt: promptHandle } : {}),
            }) ?? null;
        } catch (err) {
          console.error('[langfuse] generation create failed:', err);
        }

        const anthropicStream = await anthropic.messages.create({
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages,
          tools: TOOLS,
          stream: true,
        });

        // Per-block accumulators keyed by content_block index. Anthropic
        // streams events with `index` indicating which block they belong to.
        const blockTypes = new Map<number, 'text' | 'tool_use'>();
        const textBuffers = new Map<number, string>();
        const toolBuffers = new Map<number, ToolUseAccum>();
        const blockOrder: number[] = [];

        let roundTokensIn: number | undefined;
        let roundTokensOut: number | undefined;
        let roundCacheCreation: number | undefined;
        let roundCacheRead: number | undefined;
        let stopReason: string | null = null;
        let roundOutputText = '';

        for await (const event of anthropicStream) {
          if (event.type === 'message_start') {
            const u = event.message?.usage;
            if (u?.input_tokens !== undefined) roundTokensIn = u.input_tokens;
            if (u?.cache_creation_input_tokens) {
              roundCacheCreation = u.cache_creation_input_tokens;
            }
            if (u?.cache_read_input_tokens) {
              roundCacheRead = u.cache_read_input_tokens;
            }
            if (event.message?.model) model = event.message.model;
          } else if (event.type === 'content_block_start') {
            const idx = event.index;
            blockOrder.push(idx);
            const cb = event.content_block;
            if (cb.type === 'text') {
              blockTypes.set(idx, 'text');
              textBuffers.set(idx, '');
            } else if (cb.type === 'tool_use') {
              blockTypes.set(idx, 'tool_use');
              toolBuffers.set(idx, {
                id: cb.id,
                name: cb.name,
                jsonBuffer: '',
              });
            }
          } else if (event.type === 'content_block_delta') {
            const idx = event.index;
            const blockType = blockTypes.get(idx);
            if (blockType === 'text' && event.delta.type === 'text_delta') {
              const text = event.delta.text;
              if (firstTokenAt === null) firstTokenAt = Date.now();
              accumulated += text;
              roundOutputText += text;
              textBuffers.set(idx, (textBuffers.get(idx) ?? '') + text);
              emit(controller, { type: 'delta', text });
            } else if (
              blockType === 'tool_use' &&
              event.delta.type === 'input_json_delta'
            ) {
              const acc = toolBuffers.get(idx);
              if (acc) acc.jsonBuffer += event.delta.partial_json;
            }
          } else if (event.type === 'message_delta') {
            if (event.usage?.output_tokens !== undefined) {
              roundTokensOut = event.usage.output_tokens;
            }
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
          }
        }

        // End-of-round Langfuse: emit usage + per-round output text. Cache
        // tokens are per-call (only the first call typically writes the
        // system prompt cache; subsequent calls read it).
        try {
          if (generation) {
            const usageDetails: Record<string, number> = {};
            if (roundTokensIn !== undefined) usageDetails.input = roundTokensIn;
            if (roundTokensOut !== undefined)
              usageDetails.output = roundTokensOut;
            if (roundTokensIn !== undefined && roundTokensOut !== undefined) {
              usageDetails.total = roundTokensIn + roundTokensOut;
            }
            if (roundCacheCreation !== undefined) {
              usageDetails.cache_creation_input_tokens = roundCacheCreation;
            }
            if (roundCacheRead !== undefined) {
              usageDetails.cache_read_input_tokens = roundCacheRead;
            }
            generation.end({
              output: roundOutputText,
              usageDetails,
              metadata: {
                stop_reason: stopReason,
                latencyMs: Date.now() - startMs,
              },
            });
          }
        } catch (err) {
          console.error('[langfuse] generation end failed:', err);
        }

        // Aggregate token counts across rounds. For input_tokens / cache_*
        // we sum across rounds — the second call's input includes the
        // first call's assistant message + tool_result, so summing reflects
        // actual prompt-token spend.
        if (roundTokensIn !== undefined) {
          totalTokensIn = (totalTokensIn ?? 0) + roundTokensIn;
        }
        if (roundTokensOut !== undefined) {
          totalTokensOut = (totalTokensOut ?? 0) + roundTokensOut;
        }
        if (roundCacheCreation !== undefined) {
          totalCacheCreationTokens =
            (totalCacheCreationTokens ?? 0) + roundCacheCreation;
        }
        if (roundCacheRead !== undefined) {
          totalCacheReadTokens = (totalCacheReadTokens ?? 0) + roundCacheRead;
        }

        const contentBlocks: StreamRoundResult['contentBlocks'] = [];
        for (const idx of blockOrder) {
          const type = blockTypes.get(idx);
          if (type === 'text') {
            const text = textBuffers.get(idx) ?? '';
            if (text.length > 0) contentBlocks.push({ type: 'text', text });
          } else if (type === 'tool_use') {
            const acc = toolBuffers.get(idx);
            if (!acc) continue;
            let input: unknown = {};
            try {
              input =
                acc.jsonBuffer.length > 0 ? JSON.parse(acc.jsonBuffer) : {};
            } catch (err) {
              console.error(
                '[chat] tool input JSON parse failed:',
                err,
                'buffer:',
                acc.jsonBuffer,
              );
            }
            contentBlocks.push({
              type: 'tool_use',
              id: acc.id,
              name: acc.name,
              input,
            });
          }
        }

        return {
          contentBlocks,
          stopReason,
          usage: {
            input_tokens: roundTokensIn,
            output_tokens: roundTokensOut,
            cache_creation_input_tokens: roundCacheCreation,
            cache_read_input_tokens: roundCacheRead,
          },
          model,
          generation,
        };
      }

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const result = await runRound(round);

          // Append assistant message to conversation history.
          messages.push({ role: 'assistant', content: result.contentBlocks });

          const toolUseBlocks = result.contentBlocks.filter(
            (
              b,
            ): b is {
              type: 'tool_use';
              id: string;
              name: string;
              input: unknown;
            } => b.type === 'tool_use',
          );

          if (result.stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
            // Sonnet finished without (or done with) tool calls. Exit loop.
            break;
          }

          // Execute each tool block in order, build tool_result content
          // blocks, then continue the conversation. One Langfuse span per
          // tool execution captures the query + chunk metadata.
          ragMeta.rag_retrieved = true;
          const toolResults: Array<{
            type: 'tool_result';
            tool_use_id: string;
            content: string;
          }> = [];
          for (const block of toolUseBlocks) {
            if (!isToolName(block.name)) {
              console.error('[chat] unknown tool name:', block.name);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `[Unknown tool: ${block.name}]`,
              });
              continue;
            }
            // Tool input shape varies by tool — search_* takes `query`,
            // fetch_url takes `url`. Pull whichever is present for
            // the tool-execution span's display string; pass the full
            // input through to executeTool which knows the per-tool
            // parsing.
            const rawInput = (block.input ?? {}) as Record<string, unknown>;
            const inputDisplay =
              typeof rawInput.query === 'string'
                ? rawInput.query
                : typeof rawInput.url === 'string'
                  ? rawInput.url
                  : '';

            // Tool-execution spans are children of THIS round's generation
            // — the one that actually emitted the tool_use blocks we're
            // executing (round 0 for parallel turns, the current round for
            // sequential ones). Fall through to trace-level if the round's
            // generation wasn't created.
            let span: ReturnType<NonNullable<typeof trace>['span']> | null =
              null;
            try {
              const parent = result.generation ?? trace;
              span =
                parent?.span({
                  name: 'tool-execution',
                  input: { tool: block.name, input: rawInput },
                  startTime: new Date(),
                }) ?? null;
            } catch (err) {
              console.error('[langfuse] span create failed:', err);
            }

            try {
              const toolResult = await executeTool(block.name, rawInput, span);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: toolResult.formatted,
              });
              ragMeta.rag_queries.push(inputDisplay);
              if (!ragMeta.rag_sources.includes(toolResult.metadata.source)) {
                ragMeta.rag_sources.push(toolResult.metadata.source);
              }
              for (const id of toolResult.metadata.chunk_ids) {
                ragMeta.rag_top_chunk_ids.push(String(id));
              }
              if (toolResult.metadata.no_match) {
                ragMeta.rag_no_match = true;
              }
              try {
                span?.end({
                  output: {
                    source: toolResult.metadata.source,
                    chunk_ids: toolResult.metadata.chunk_ids,
                    top_scores: toolResult.metadata.top_scores,
                  },
                });
              } catch (err) {
                console.error('[langfuse] span end failed:', err);
              }
            } catch (err) {
              console.error('[chat] tool execution failed:', err);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `[Tool execution failed: ${err instanceof Error ? err.message : String(err)}]`,
              });
              try {
                span?.end({
                  output: {
                    error: err instanceof Error ? err.message : String(err),
                  },
                });
              } catch {
                // swallow
              }
            }
          }

          messages.push({ role: 'user', content: toolResults });
          // Loop continues for the next round.
        }

        emit(controller, {
          type: 'rag',
          rag_used: ragMeta.rag_retrieved,
          sources: ragMeta.rag_sources,
        });
        emit(controller, {
          type: 'usage',
          input_tokens: totalTokensIn ?? 0,
          output_tokens: totalTokensOut ?? 0,
          cache_creation_input_tokens: totalCacheCreationTokens ?? 0,
          cache_read_input_tokens: totalCacheReadTokens ?? 0,
          model: model ?? null,
        });
        emit(controller, { type: 'done' });
      } catch (err) {
        console.error('[chat] anthropic stream error:', err);
        tags.push('streamed-error');
        fireAndForget(
          resOrCtx,
          logChatError({
            ipHash,
            q,
            category: 'anthropic',
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        checkAndSendSpike(resOrCtx);
        emit(controller, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        // Partial rag/usage state — emit what's known so the eval
        // runner's stream parser sees a uniform protocol on the
        // error path too.
        emit(controller, {
          type: 'rag',
          rag_used: ragMeta.rag_retrieved,
          sources: ragMeta.rag_sources,
        });
        emit(controller, {
          type: 'usage',
          input_tokens: totalTokensIn ?? 0,
          output_tokens: totalTokensOut ?? 0,
          cache_creation_input_tokens: totalCacheCreationTokens ?? 0,
          cache_read_input_tokens: totalCacheReadTokens ?? 0,
          model: model ?? null,
        });
        emit(controller, { type: 'done' });
      } finally {
        const latencyMs = Date.now() - startMs;
        const ttftMs = firstTokenAt !== null ? firstTokenAt - startMs : null;
        // (f) output canary leak check — post-stream, server-side. The canary
        // has already been flushed to the client in deltas if it leaked; we
        // redact here only for the log preview and flag the turn for review.
        const leak = detectOutputLeak(accumulated);
        if (leak.hit) {
          console.error(
            '[chat] output canary leak detected for ip:',
            ipHash.slice(0, 8),
          );
          accumulated = accumulated.split(CANARY_TOKEN).join('[REDACTED]');
          tags.push('canary-leak');
          fireAndForget(resOrCtx, recordAndAlertLeak(req, ipHash));
        }
        // Heuristic refusal detection. Cheap substring match against the
        // system prompt's templates plus a word-count guard so substantive
        // long responses are not flagged. Can co-exist with canary-leak
        // and streamed-error on the same trace.
        if (detectRefusal(accumulated)) {
          tags.push('model-refused');
        }
        // Grounded: RAG fired this turn and at least one source returned
        // usable chunks (not a no-match). Source of truth for the HUD's
        // queries_grounded %. Independent of model-refused — a turn can
        // retrieve context and still hedge; both tags can co-exist.
        if (ragMeta.rag_retrieved && !ragMeta.rag_no_match) {
          tags.push('grounded');
        }
        // (g) log turn — await BEFORE close so dev-mode inline wait holds the
        // stream open until the log completes; Edge prod uses waitUntil and
        // returns immediately so the order is harmless there.
        await fireAndForget(
          resOrCtx,
          logChatTurn({
            ipHash,
            q,
            aPreview: accumulated.slice(0, 280),
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            cacheCreationTokens: totalCacheCreationTokens,
            cacheReadTokens: totalCacheReadTokens,
            model,
            latencyMs,
            ...(leak.hit && { canary_leak: true }),
          }).catch((err) => {
            console.error('[chat] chat log write failed:', err);
          }),
        );
        // Direct await: drains Langfuse SDK's pendingIngestionPromises
        // before the stream closes and Vercel reclaims the function.
        // Stream content is already enqueued; TTFT/response unaffected.
        await finalizeTrace(lf, trace, tags, accumulated, ragMeta);
        void ttftMs;
        controller.close();
      }
    },
  });

  return writeResponse(
    resOrCtx,
    new Response(stream, { headers: NDJSON_HEADERS }),
  );
}
