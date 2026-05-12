import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from './_systemPrompt';
import { detectInjection } from './_injection';
import { checkRateLimit, hashIp, logChatTurn } from './_kv';

export const runtime = 'edge';

// `vercel dev` passes a Node IncomingMessage; production Edge passes a Web
// `Request`. parseBody handles both so the same handler works in both worlds.
type CompatRequest =
  | Request
  | { method?: string; headers: unknown; on?: unknown; setEncoding?: unknown };

type CompatNodeRes = {
  setHeader: (k: string, v: string) => void;
  write: (chunk: string | Uint8Array) => void;
  end: () => void;
  statusCode: number;
  flushHeaders?: () => void;
};

// `vercel dev` invokes handlers with a Node http.ServerResponse as the second
// arg and expects bytes written to it; production Edge passes a context with
// `waitUntil` and consumes the returned `Response`. writeResponse picks the
// right path per environment.
async function writeResponse(
  resOrCtx: unknown,
  response: Response,
): Promise<Response | void> {
  const maybe = resOrCtx as Partial<CompatNodeRes> | undefined;
  const isNodeRes =
    typeof maybe?.setHeader === 'function' &&
    typeof maybe?.end === 'function';

  if (!isNodeRes) {
    // Production Edge runtime — return the Response unchanged.
    return response;
  }

  const nodeRes = maybe as CompatNodeRes;
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    nodeRes.setHeader(key, value);
  });
  nodeRes.flushHeaders?.();

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  nodeRes.end();
  // void — bytes already written to the Node response
}

async function parseBody(req: CompatRequest): Promise<unknown> {
  // Path 1: Web standard Request (production Edge runtime).
  if (typeof (req as Request).json === 'function') {
    return (req as Request).json().catch(() => null);
  }

  const nodeReq = req as {
    body?: unknown;
    setEncoding?: (e: string) => void;
    on: (
      ev: 'data' | 'end' | 'error',
      cb: (chunk?: string) => void,
    ) => void;
  };

  // Path 2: vercel dev's @vercel/node wrapper pre-buffers the body onto
  // `req.body` before invoking the handler — by the time we'd attach
  // 'data'/'end' listeners, the stream has already ended and our listeners
  // would wait forever. Check this first.
  if (nodeReq.body !== undefined && nodeReq.body !== null) {
    if (typeof nodeReq.body === 'string') {
      try {
        return JSON.parse(nodeReq.body);
      } catch {
        return null;
      }
    }
    // @vercel/node may auto-parse JSON content-type into an object already.
    return nodeReq.body;
  }

  // Path 3: true Node IncomingMessage stream — fallback for cases where the
  // body wasn't pre-buffered. Rare in vercel dev, but safe to keep.
  return new Promise((resolve) => {
    let body = '';
    nodeReq.setEncoding?.('utf-8');
    nodeReq.on('data', (chunk) => {
      body += chunk;
    });
    nodeReq.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    nodeReq.on('error', () => resolve(null));
  });
}

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
