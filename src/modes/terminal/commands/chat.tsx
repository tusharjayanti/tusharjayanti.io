import type { ScrollbackEntry } from './index';
import { streamChat } from '../../../lib/chat';

export async function runChat(
  input: string,
  append: (entry: ScrollbackEntry) => void,
  updateById: (
    id: string,
    updater: (entry: ScrollbackEntry) => ScrollbackEntry,
  ) => void,
  signal: AbortSignal,
): Promise<void> {
  const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Append loader entry immediately (empty text → renders as `█ thinking`)
  append({
    kind: 'chat-streaming',
    id,
    text: '',
    done: false,
    isError: false,
  });

  try {
    for await (const event of streamChat(input, { signal })) {
      if (event.type === 'delta') {
        updateById(id, (entry) => {
          if (entry.kind !== 'chat-streaming') return entry;
          return { ...entry, text: entry.text + event.text };
        });
      } else if (event.type === 'error') {
        updateById(id, (entry) => {
          if (entry.kind !== 'chat-streaming') return entry;
          return {
            ...entry,
            text: event.message,
            done: true,
            isError: true,
          };
        });
      } else if (event.type === 'done') {
        updateById(id, (entry) => {
          if (entry.kind !== 'chat-streaming') return entry;
          return { ...entry, done: true };
        });
      }
    }
  } catch (err) {
    // Non-abort errors get a user-facing message. AbortError (user sent a new
    // command or navigated away) is finalized quietly by the finally below.
    if ((err as Error).name !== 'AbortError') {
      updateById(id, (entry) => {
        if (entry.kind !== 'chat-streaming') return entry;
        return {
          ...entry,
          text: '# something broke on my end. give me a moment and try again.',
          done: true,
          isError: true,
        };
      });
    }
  } finally {
    // Guarantee the entry is finalized no matter how the loop exited (normal
    // done, error event, thrown error, or abort). An entry left un-done would
    // render the "thinking" loader forever; an aborted entry with no content
    // shows an interrupted marker instead of a blank line.
    updateById(id, (entry) => {
      if (entry.kind !== 'chat-streaming' || entry.done) return entry;
      const interrupted = entry.text.length === 0;
      return {
        ...entry,
        text: interrupted ? '# [interrupted]' : entry.text,
        done: true,
        isError: interrupted,
      };
    });
  }
}
