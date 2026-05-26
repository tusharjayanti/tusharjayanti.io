// Tests for streamChat's abort-signaling contract: an abort must surface to
// the caller as a thrown AbortError regardless of whether it lands before the
// response headers (fetch rejects) or mid-stream (reader.read rejects). A
// normally-completed stream must not throw. fetch is stubbed; no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamChat, type ChatDelta } from './chat';

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// Pull-based streams guarantee chunks are delivered in order before the
// terminal close/error (enqueue+error in start() can drop queued chunks).
function streamThenClose(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) controller.enqueue(enc.encode(lines[i++] + '\n'));
      else controller.close();
    },
  });
}

function streamThenError(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) controller.enqueue(enc.encode(lines[i++] + '\n'));
      else controller.error(abortError());
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

async function drain(gen: AsyncGenerator<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('streamChat abort signaling', () => {
  it('throws AbortError when fetch is aborted pre-headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortError();
      }),
    );
    await expect(drain(streamChat('q'))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('throws AbortError when aborted mid-stream, after yielding earlier deltas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(streamThenError(['{"type":"delta","text":"hi"}'])),
      ),
    );
    const events: ChatDelta[] = [];
    await expect(
      (async () => {
        for await (const e of streamChat('q')) events.push(e);
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([{ type: 'delta', text: 'hi' }]);
  });

  it('does not throw when the stream completes normally (done received)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(
          streamThenClose(['{"type":"delta","text":"hi"}', '{"type":"done"}']),
        ),
      ),
    );
    const events = await drain(streamChat('q'));
    expect(events).toEqual([{ type: 'delta', text: 'hi' }, { type: 'done' }]);
  });
});
