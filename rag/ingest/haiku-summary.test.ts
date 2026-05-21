// Tests for the Haiku contextual summary generator. All Anthropic
// calls are mocked — no live API traffic. Covers:
//   - prompt structure (system + user message shape with prev/this/next)
//   - edge cases (no prev, no next, both missing)
//   - output normalization (quote-stripping, whitespace collapse,
//     200-char hard truncate)
//   - token-usage propagation

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.messagesCreate };
  },
}));

vi.mock('../../api/_langfuse.js', () => ({
  getLangfuse: () => null,
  makeSystemPromptHandle: () => null,
}));

const { summarizeChunk, HAIKU_MODEL, SUMMARY_MAX_CHARS } = await import(
  './haiku-summary.js'
);

function fakeResponse(text: string, inputTokens = 200, outputTokens = 30) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('summarizeChunk', () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key';
  });

  it('calls Haiku with the configured model + max_tokens, system + user payload', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('Plain summary.'));
    await summarizeChunk({
      prev: 'Prev chunk content.',
      current: 'Current chunk content.',
      next: 'Next chunk content.',
    });
    const callArgs = mocks.messagesCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe(HAIKU_MODEL);
    expect(typeof callArgs.system).toBe('string');
    expect(callArgs.max_tokens).toBeGreaterThan(0);
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe('user');
    const userText = callArgs.messages[0].content;
    expect(userText).toContain('PREVIOUS CHUNK:');
    expect(userText).toContain('Prev chunk content.');
    expect(userText).toContain('CHUNK TO SUMMARIZE:');
    expect(userText).toContain('Current chunk content.');
    expect(userText).toContain('NEXT CHUNK:');
    expect(userText).toContain('Next chunk content.');
  });

  it('inserts a "first chunk" sentinel when prev is null', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('Summary.'));
    await summarizeChunk({
      prev: null,
      current: 'Current.',
      next: 'Next.',
    });
    const userText = mocks.messagesCreate.mock.calls[0]![0].messages[0].content;
    expect(userText).toContain('(none — this is the first chunk)');
    expect(userText).toContain('Next.');
  });

  it('inserts a "last chunk" sentinel when next is null', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('Summary.'));
    await summarizeChunk({
      prev: 'Prev.',
      current: 'Current.',
      next: null,
    });
    const userText = mocks.messagesCreate.mock.calls[0]![0].messages[0].content;
    expect(userText).toContain('Prev.');
    expect(userText).toContain('(none — this is the last chunk)');
  });

  it('handles both neighbors missing (single-chunk source)', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('Lone summary.'));
    const result = await summarizeChunk({
      prev: null,
      current: 'Only chunk.',
      next: null,
    });
    const userText = mocks.messagesCreate.mock.calls[0]![0].messages[0].content;
    expect(userText).toContain('(none — this is the first chunk)');
    expect(userText).toContain('(none — this is the last chunk)');
    expect(result.summary).toBe('Lone summary.');
  });

  it('strips wrapping double-quotes from the response', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('"Quoted summary."'));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe('Quoted summary.');
  });

  it('strips wrapping single-quotes from the response', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse("'Apostrophed.'"));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe('Apostrophed.');
  });

  it('strips wrapping backticks from the response', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('`Backticked.`'));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe('Backticked.');
  });

  it('collapses internal newlines and whitespace runs', async () => {
    mocks.messagesCreate.mockResolvedValue(
      fakeResponse('Summary  with\n\nweird   spacing.'),
    );
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe('Summary with weird spacing.');
  });

  it('falls back to word boundary when response has no sentence boundary in first 200 chars', async () => {
    // ~400 chars of repeated words, no `.!?` anywhere. Truncation
    // should cut at the last space before char 200, not mid-word.
    const longResponse = 'word '.repeat(80);
    mocks.messagesCreate.mockResolvedValue(fakeResponse(longResponse));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    // Last char of the truncated summary is the end of a "word", not
    // a space (we sliced at the space, then implicitly trimmed).
    expect(result.summary.endsWith(' ')).toBe(false);
    expect(result.summary).toMatch(/^(word )+word$/);
  });

  it('truncates at the last sentence boundary when one exists within first 200 chars', async () => {
    // Calculator-agent chunk 2 reproduction: model output longer than
    // 200 chars, but the last `.` sits well before the 200 boundary.
    // The new truncator must cut at that sentence boundary, not at
    // 200 chars mid-word.
    const longResponse =
      'New providers are added by implementing the BaseLLMClient interface with a model property and complete method. The rest of the agent features like history and exports work automatically with any provider implementing this interface correctly.';
    mocks.messagesCreate.mockResolvedValue(fakeResponse(longResponse));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe(
      'New providers are added by implementing the BaseLLMClient interface with a model property and complete method.',
    );
    // Crucially, no mid-word `...any pro` tail.
    expect(result.summary.endsWith('any pro')).toBe(false);
    expect(result.summary.endsWith('.')).toBe(true);
  });

  it('hard-truncates only when no sentence or word boundary exists', async () => {
    // Pathological: single 300-char unspaced token. Falls through both
    // boundary cases to the hard char cap.
    const wallOfChars = 'x'.repeat(300);
    mocks.messagesCreate.mockResolvedValue(fakeResponse(wallOfChars));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(result.summary).toBe('x'.repeat(SUMMARY_MAX_CHARS));
  });

  it('keeps a summary that fits within SUMMARY_MAX_CHARS unchanged', async () => {
    const short = 'A short summary that fits cleanly.';
    mocks.messagesCreate.mockResolvedValue(fakeResponse(short));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.summary).toBe(short);
  });

  it('propagates token usage from the Anthropic response', async () => {
    mocks.messagesCreate.mockResolvedValue(fakeResponse('s.', 123, 17));
    const result = await summarizeChunk({
      prev: null,
      current: 'C.',
      next: null,
    });
    expect(result.inputTokens).toBe(123);
    expect(result.outputTokens).toBe(17);
  });
});
