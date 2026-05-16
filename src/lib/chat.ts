export type ChatDelta =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | {
      type: 'error';
      message: string;
      category: 'network' | 'server' | 'rate-limit' | 'validation';
    };

export type StreamChatOptions = {
  signal?: AbortSignal;
};

export async function* streamChat(
  q: string,
  opts: StreamChatOptions = {},
): AsyncGenerator<ChatDelta> {
  let response: Response;

  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
      signal: opts.signal,
    });
  } catch (err) {
    // AbortError is user-initiated (new command or unmount); don't surface
    // as an error event — runChat's outer catch handles the abort path.
    if ((err as Error).name === 'AbortError') return;
    yield {
      type: 'error',
      message:
        "# can't reach me right now. probably my fault. try again in a sec?",
      category: 'network',
    };
    yield { type: 'done' };
    return;
  }

  if (!response.ok) {
    const status = response.status;
    let category: 'server' | 'rate-limit' | 'validation' = 'server';
    let message =
      "# surprisingly something's wrong with my engineering. !! ¯\\_(ツ)_/¯ !!";
    if (status === 429) {
      category = 'rate-limit';
      message =
        "# you've used your 15 questions for this hour. catch you on the next one.";
    } else if (status === 400) {
      category = 'validation';
      message = "# that didn't quite land. try rephrasing?";
    }
    yield { type: 'error', message, category };
    yield { type: 'done' };
    return;
  }

  if (!response.body) {
    yield {
      type: 'error',
      message:
        "# surprisingly something's wrong with my engineering. !! ¯\\_(ツ)_/¯ !!",
      category: 'server',
    };
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
