// Regression tests for the chat tool-use loop's terminal behavior.
//
// Trace 8fb6eb68 ran tool_use on every round chasing an unanswerable
// sub-question ("current stock performance"), hit the round cap on a
// tool round, and exited with no follow-up generation — leaving the
// turn's output empty/undefined and the user with no reply.
//
// These tests drive the real handler (api/chat.ts) with a mocked
// Anthropic streaming client and assert the invariant the fix
// guarantees: a multi-part query with an unanswerable part returns a
// NON-EMPTY response within the round cap, never undefined. All
// external I/O (Anthropic, Redis, Langfuse, RAG tools) is mocked — no
// network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared Anthropic stub, reconfigured per test. vi.hoisted so the
// vi.mock factory below can close over it.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('./_kv.js', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true, count: 1 })),
  hashIp: vi.fn(async () => 'iphash0000000000'),
  logChatError: vi.fn(async () => {}),
  logChatTurn: vi.fn(async () => {}),
  getHourlyErrorCount: vi.fn(async () => 0),
  recordLeakEvent: vi.fn(async () => ({
    ts: 0,
    canary: '',
    ipHash: '',
    userAgent: '',
    geoCountry: null,
  })),
  shouldSendSpikeAlert: vi.fn(async () => false),
  updateLeakLastAlertedAt: vi.fn(async () => {}),
}));

// Disable Langfuse entirely (getLangfuse -> null short-circuits every
// trace/generation/span call in the handler).
vi.mock('./_langfuse.js', () => ({
  getLangfuse: vi.fn(() => null),
  makeSystemPromptHandle: vi.fn(() => null),
}));

// RAG tools: every call is a no-match (the realistic shape for an
// unanswerable sub-question). isToolName always true so the loop
// executes the stubbed tool.
vi.mock('./_tools.js', () => ({
  TOOLS: [],
  isToolName: vi.fn(() => true),
  executeTool: vi.fn(async () => ({
    formatted: 'No relevant results found.',
    metadata: {
      source: 'experience',
      chunk_ids: [],
      top_scores: [],
      no_match: true,
    },
  })),
}));

import handler, { EMPTY_OUTPUT_FALLBACK, MAX_TOOL_ROUNDS } from './chat.js';

const MODEL = 'claude-sonnet-4-6';

// --- Anthropic streaming-event generators ----------------------------
// Each models one round of `anthropic.messages.create({ stream: true })`
// as the async-iterable of events the handler consumes.

async function* toolUseRound(id: string) {
  yield {
    type: 'message_start',
    message: { usage: { input_tokens: 10 }, model: MODEL },
  };
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name: 'search_experience' },
  };
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"query":"stock"}' },
  };
  yield { type: 'content_block_stop', index: 0 };
  yield {
    type: 'message_delta',
    usage: { output_tokens: 5 },
    delta: { stop_reason: 'tool_use' },
  };
  yield { type: 'message_stop' };
}

async function* textRound(text: string) {
  yield {
    type: 'message_start',
    message: { usage: { input_tokens: 10 }, model: MODEL },
  };
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  };
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  };
  yield { type: 'content_block_stop', index: 0 };
  yield {
    type: 'message_delta',
    usage: { output_tokens: 5 },
    delta: { stop_reason: 'end_turn' },
  };
  yield { type: 'message_stop' };
}

// A round that ends the turn producing NO text at all — the worst case
// the empty-output backstop must catch.
async function* emptyEndRound() {
  yield {
    type: 'message_start',
    message: { usage: { input_tokens: 10 }, model: MODEL },
  };
  yield {
    type: 'message_delta',
    usage: { output_tokens: 0 },
    delta: { stop_reason: 'end_turn' },
  };
  yield { type: 'message_stop' };
}

// --- harness ---------------------------------------------------------

type StreamEvent = { type: string; text?: string; [k: string]: unknown };

// Drive the handler via the Edge path (Web Request in, Response out) and
// parse the NDJSON stream into events.
async function runHandler(q: string): Promise<StreamEvent[]> {
  const req = new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q }),
  });
  const res = (await handler(req)) as Response;
  expect(res).toBeInstanceOf(Response);
  const body = await res.text();
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function answerText(events: StreamEvent[]): string {
  return events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text ?? '')
    .join('');
}

describe('chat tool-loop terminal behavior', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns non-empty text within the round cap when the model keeps wanting tools', async () => {
    // tool_use on every tool-enabled round; the forced final round (tools
    // disabled) produces the actual answer.
    let call = 0;
    createMock.mockImplementation(
      async (params: { tool_choice?: { type?: string } }) => {
        call += 1;
        if (params.tool_choice?.type === 'none') {
          return textRound(
            'I owned auth at DISCO at ~3000 RPS. I do not have live stock data.',
          );
        }
        return toolUseRound(`tu_${call}`);
      },
    );

    const events = await runHandler(
      'Tell me about your DISCO work and your current stock performance',
    );
    const answer = answerText(events);

    expect(answer.length).toBeGreaterThan(0);
    expect(answer).toContain('DISCO');
    // Never exceeded the cap.
    expect(createMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    // The final round disabled tools; earlier rounds did not.
    const calls = createMock.mock.calls as Array<[{ tool_choice?: unknown }]>;
    expect(calls[0][0].tool_choice).toBeUndefined();
    expect(calls[MAX_TOOL_ROUNDS - 1][0].tool_choice).toEqual({ type: 'none' });
    // Stream terminated cleanly.
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('falls back to a non-empty reply when even the forced final round is empty', async () => {
    // Closest reproduction of trace 8fb6eb68: tool_use every round, and
    // the forced final round still yields no text. The backstop must
    // produce the fallback.
    let call = 0;
    createMock.mockImplementation(
      async (params: { tool_choice?: { type?: string } }) => {
        call += 1;
        if (params.tool_choice?.type === 'none') return emptyEndRound();
        return toolUseRound(`tu_${call}`);
      },
    );

    const events = await runHandler(
      'tell me about DISCO and your current stock price',
    );
    const answer = answerText(events);

    expect(answer).toBe(EMPTY_OUTPUT_FALLBACK);
    expect(createMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('falls back when the very first round ends with no text', async () => {
    createMock.mockImplementation(async () => emptyEndRound());

    const events = await runHandler('what is your current stock price');
    const answer = answerText(events);

    expect(answer).toBe(EMPTY_OUTPUT_FALLBACK);
    // No tools wanted -> single round, well under the cap.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does not disable tools or force a fallback on a normal answered turn', async () => {
    createMock.mockImplementation(async () =>
      textRound('I led authentication and authorization at DISCO.'),
    );

    const events = await runHandler('What did you build at DISCO?');
    const answer = answerText(events);

    expect(answer).toContain('DISCO');
    expect(createMock).toHaveBeenCalledTimes(1);
    const calls = createMock.mock.calls as Array<[{ tool_choice?: unknown }]>;
    expect(calls[0][0].tool_choice).toBeUndefined();
    // The genuine answer is not the fallback.
    expect(answer).not.toBe(EMPTY_OUTPUT_FALLBACK);
  });
});
