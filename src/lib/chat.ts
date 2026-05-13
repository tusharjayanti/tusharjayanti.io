export type ChatDelta =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type StreamChatOptions = {
  signal?: AbortSignal;
};

export async function* streamChat(
  q: string,
  opts: StreamChatOptions = {},
): AsyncGenerator<ChatDelta> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    try {
      const errObj = JSON.parse(errorText);
      yield {
        type: 'error',
        message: errObj.error || `request failed: ${response.status}`,
      };
    } catch {
      yield {
        type: 'error',
        message: `request failed: ${response.status}`,
      };
    }
    yield { type: 'done' };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: 'no response body' };
    yield { type: 'done' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as ChatDelta;
          yield event;
          if (event.type === 'done') return;
        } catch {
          // malformed line — skip
        }
      }
    }

    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        const event = JSON.parse(trimmed) as ChatDelta;
        yield event;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}
