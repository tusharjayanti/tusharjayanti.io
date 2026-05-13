import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from './_systemPrompt';
import { detectInjection } from './_injection';
import {
  checkRateLimit,
  getHourlyErrorCount,
  hashIp,
  logChatError,
  logChatTurn,
  shouldSendSpikeAlert,
} from './_kv';
import {
  parseBody,
  writeResponse,
  type CompatRequest,
} from './_compat';

export const runtime = 'edge';

const MAX_Q_LENGTH = 500;
const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

const REFUSAL_TEXT =
  'Not how this works. Want to know what I built at DISCO?';
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
      const { sendEmail } = await import('./_resend');
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
          error: `expected { q: string } with 1..${MAX_Q_LENGTH} chars`,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
  }

  // (b) ip hash
  const ipHash = await hashIp(req);

  // (c) rate limit
  const { ok, count } = await checkRateLimit(ipHash);
  if (!ok) {
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
        detail: `count: ${count}, window: 1 hour, limit: 15`,
      }),
    );
    checkAndSendSpike(resOrCtx);
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

  // (d) injection guard
  const inj = detectInjection(q);
  if (inj.hit) {
    console.warn('[chat] injection probe detected:', {
      reason: inj.reason,
      qPreview: q.slice(0, 100),
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        emit(controller, { type: 'delta', text: REFUSAL_TEXT });
        emit(controller, { type: 'done' });
        // await log BEFORE close so the dev-mode inline wait keeps the
        // function alive long enough for the log write to land.
        await fireAndForget(
          resOrCtx,
          logChatTurn({ ipHash, q, aPreview: REFUSAL_TEXT }).catch((err) => {
            console.error('[chat] chat log write failed:', err);
          }),
        );
        controller.close();
      },
    });
    return writeResponse(
      resOrCtx,
      new Response(stream, { headers: NDJSON_HEADERS }),
    );
  }

  // (e) Anthropic stream
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let accumulated = '';
      try {
        const anthropicStream = await anthropic.messages.create({
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: q }],
          stream: true,
        });

        for await (const event of anthropicStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            const text = event.delta.text;
            accumulated += text;
            emit(controller, { type: 'delta', text });
          }
        }
        emit(controller, { type: 'done' });
      } catch (err) {
        console.error('[chat] anthropic stream error:', err);
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
        emit(controller, { type: 'done' });
      } finally {
        // (f) log turn — await BEFORE close so dev-mode inline wait holds the
        // stream open until the log completes; Edge prod uses waitUntil and
        // returns immediately so the order is harmless there.
        await fireAndForget(
          resOrCtx,
          logChatTurn({
            ipHash,
            q,
            aPreview: accumulated.slice(0, 280),
          }).catch((err) => {
            console.error('[chat] chat log write failed:', err);
          }),
        );
        controller.close();
      }
    },
  });

  return writeResponse(
    resOrCtx,
    new Response(stream, { headers: NDJSON_HEADERS }),
  );
}
