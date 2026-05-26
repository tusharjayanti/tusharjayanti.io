// Tests for runChat's entry-finalization contract: the chat-streaming entry
// must always end with done=true regardless of how the stream exits — normal
// completion, error event, thrown error, or abort. Aborted-with-no-content
// shows an interrupted marker rather than a blank/forever-"thinking" entry.
// streamChat is mocked; no network, no DOM.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ streamChat: vi.fn() }));
vi.mock('../../../lib/chat', () => ({ streamChat: mocks.streamChat }));

import { runChat } from './chat';
import type { ScrollbackEntry } from './index';

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

async function* gen(events: unknown[], throwAtEnd?: Error) {
  for (const e of events) yield e;
  if (throwAtEnd) throw throwAtEnd;
}

function harness() {
  const entries: ScrollbackEntry[] = [];
  const append = (e: ScrollbackEntry) => entries.push(e);
  const updateById = (
    id: string,
    updater: (e: ScrollbackEntry) => ScrollbackEntry,
  ) => {
    const idx = entries.findIndex(
      (e) => e.kind === 'chat-streaming' && e.id === id,
    );
    if (idx !== -1) entries[idx] = updater(entries[idx]);
  };
  const entry = () => entries.find((e) => e.kind === 'chat-streaming')!;
  return { append, updateById, entry };
}

const signal = new AbortController().signal;

beforeEach(() => mocks.streamChat.mockReset());

describe('runChat entry finalization', () => {
  it('successful stream: text accumulated, done=true, not error', async () => {
    mocks.streamChat.mockReturnValue(
      gen([{ type: 'delta', text: 'hello' }, { type: 'done' }]),
    );
    const h = harness();
    await runChat('q', h.append, h.updateById, signal);
    expect(h.entry()).toMatchObject({
      text: 'hello',
      done: true,
      isError: false,
    });
  });

  it('aborted pre-headers (throws, no content): renders [interrupted], done=true', async () => {
    mocks.streamChat.mockReturnValue(gen([], abortError()));
    const h = harness();
    await runChat('q', h.append, h.updateById, signal);
    expect(h.entry()).toMatchObject({
      text: '# [interrupted]',
      done: true,
      isError: true,
    });
  });

  it('aborted mid-stream: partial text preserved, done=true', async () => {
    mocks.streamChat.mockReturnValue(
      gen([{ type: 'delta', text: 'partial' }], abortError()),
    );
    const h = harness();
    await runChat('q', h.append, h.updateById, signal);
    expect(h.entry()).toMatchObject({
      text: 'partial',
      done: true,
      isError: false,
    });
  });

  it('error event: message shown, done=true, isError', async () => {
    mocks.streamChat.mockReturnValue(
      gen([
        { type: 'error', message: '# rate limited', category: 'rate-limit' },
        { type: 'done' },
      ]),
    );
    const h = harness();
    await runChat('q', h.append, h.updateById, signal);
    expect(h.entry()).toMatchObject({
      text: '# rate limited',
      done: true,
      isError: true,
    });
  });

  it('non-abort thrown error: shows the generic failure message, done=true', async () => {
    mocks.streamChat.mockReturnValue(gen([], new Error('boom')));
    const h = harness();
    await runChat('q', h.append, h.updateById, signal);
    const e = h.entry();
    expect(e.kind === 'chat-streaming' && e.done).toBe(true);
    expect(e.kind === 'chat-streaming' && e.isError).toBe(true);
    expect(e.kind === 'chat-streaming' && e.text).toContain('something broke');
  });
});
