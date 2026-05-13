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
    if ((err as Error).name === 'AbortError') {
      // Aborted because user sent a new command or unmounted. Mark done quietly.
      updateById(id, (entry) => {
        if (entry.kind !== 'chat-streaming') return entry;
        return { ...entry, done: true };
      });
    } else {
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
  }
}
