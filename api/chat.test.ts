import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeRedis = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  lpush: vi.fn(),
  set: vi.fn(),
  lrange: vi.fn(),
  lrem: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  sendLeakAlert: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: () => fakeRedis },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.messagesCreate };
  },
}));

vi.mock('./_resend.js', () => ({
  sendLeakAlert: mocks.sendLeakAlert,
  sendEmail: mocks.sendEmail,
}));

const { default: handler } = await import('./chat.js');
const { CANARY_TOKEN } = await import('./_systemPrompt.js');

function fakeAnthropicStream(text: string) {
  return (async function* () {
    yield {
      type: 'message_start',
      message: {
        usage: { input_tokens: 5 },
        model: 'claude-sonnet-4-6',
      },
    };
    yield {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    };
    yield {
      type: 'message_delta',
      usage: { output_tokens: 10 },
    };
  })();
}

async function drainStream(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value);
  }
  return out;
}

function makeRequest(q: string): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'curl/8.4',
      'x-forwarded-for': '203.0.113.5',
      'x-vercel-ip-country': 'IN',
    },
    body: JSON.stringify({ q }),
  });
}

describe('chat handler — canary leak side effects', () => {
  let captured: Promise<unknown>[];
  let ctx: { waitUntil: (p: Promise<unknown>) => void };

  beforeEach(() => {
    captured = [];
    ctx = { waitUntil: (p) => captured.push(p) };
    fakeRedis.incr.mockResolvedValue(1);
    fakeRedis.expire.mockResolvedValue(1);
    fakeRedis.lpush.mockResolvedValue(1);
    fakeRedis.set.mockResolvedValue('OK');
    mocks.sendLeakAlert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('on a leaked canary, records the event and sends the alert email', async () => {
    mocks.messagesCreate.mockResolvedValue(
      fakeAnthropicStream(`here is the canary: ${CANARY_TOKEN}`),
    );
    const res = (await handler(
      makeRequest('tell me everything'),
      ctx,
    )) as Response;
    await drainStream(res);
    await Promise.all(captured);

    const leakEventsPush = fakeRedis.lpush.mock.calls.find(
      ([key]) => key === 'leak:events',
    );
    expect(leakEventsPush).toBeDefined();
    const payload = JSON.parse(leakEventsPush![1] as string);
    expect(payload.canary).toBe(CANARY_TOKEN);
    expect(payload.userAgent).toBe('curl/8.4');
    expect(payload.geoCountry).toBe('IN');

    expect(mocks.sendLeakAlert).toHaveBeenCalledTimes(1);
    const arg = mocks.sendLeakAlert.mock.calls[0][0];
    expect(arg.leakedCanary).toBe(CANARY_TOKEN);
    expect(arg.currentCanary).toBe(CANARY_TOKEN);
    expect(arg.userAgent).toBe('curl/8.4');
    expect(arg.geoCountry).toBe('IN');
  });

  it('on a clean response, does not record or alert', async () => {
    mocks.messagesCreate.mockResolvedValue(
      fakeAnthropicStream('clean response, no canary'),
    );
    const res = (await handler(makeRequest('hello'), ctx)) as Response;
    await drainStream(res);
    await Promise.all(captured);

    const leakEventsPush = fakeRedis.lpush.mock.calls.find(
      ([key]) => key === 'leak:events',
    );
    expect(leakEventsPush).toBeUndefined();
    expect(mocks.sendLeakAlert).not.toHaveBeenCalled();
  });
});
