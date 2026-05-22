// End-to-end smoke for /api/chat that bypasses the HTTP layer. Imports
// the handler directly, constructs a Web Request, and streams the
// NDJSON response to stdout while tracking TTFT, total wall-clock time,
// and tool-firing signals inferred from the server-side console logs.
//
// Reused for M2.4 (this work) and the M2.5–M2.7 verifications. Real
// Anthropic + Voyage + Supabase calls — not mocked.

import { argv, stdout } from 'node:process';

import handler from '../../api/chat.js';

type NdjsonEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

type Args = {
  query: string;
  stream: boolean;
};

function parseArgs(): Args {
  // skip [node, script.ts]
  const args = argv.slice(2);
  let stream = true;
  const positionals: string[] = [];
  for (const a of args) {
    if (a === '--no-stream') stream = false;
    else if (a === '--stream') stream = true;
    else positionals.push(a);
  }
  if (positionals.length === 0) {
    console.error('usage: tsx scripts/rag/smoke-chat.ts <query> [--no-stream]');
    process.exit(2);
  }
  return { query: positionals.join(' '), stream };
}

function parseNdjson(buffer: string): {
  events: NdjsonEvent[];
  remainder: string;
} {
  const events: NdjsonEvent[] = [];
  const lines = buffer.split('\n');
  // Last fragment may be a partial line; keep as remainder.
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as NdjsonEvent);
    } catch {
      console.error(`[smoke:chat] skipping malformed NDJSON line: ${trimmed}`);
    }
  }
  return { events, remainder };
}

async function main(): Promise<void> {
  const { query, stream: liveStream } = parseArgs();

  // Provide a waitUntil that the handler can dispatch background work to
  // (Langfuse flush, Redis log writes). Capture every promise so the
  // script can await them before exiting — otherwise traces and chat
  // logs may not land.
  const backgroundPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>): void {
      backgroundPromises.push(p);
    },
  };

  const startedAt = new Date();
  const request = new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Smoke-script marker so the trace's userId hash is stable across
      // runs against the same query (still anonymous — IP is hashed).
      'x-forwarded-for': '127.0.0.1',
      'user-agent': 'smoke:chat',
    },
    body: JSON.stringify({ q: query }),
  });

  console.log('--- query ---');
  console.log(query);
  console.log();
  console.log('--- response ---');

  const startMs = Date.now();
  const response = (await handler(request, ctx)) as Response | undefined;
  if (!response) {
    console.error('[smoke:chat] handler returned no Response');
    process.exit(1);
  }

  let ttftMs: number | null = null;
  let responseChars = 0;
  let errorMessage: string | null = null;
  let sawDone = false;
  let bufferedOutput = '';

  if (!response.body) {
    console.error('[smoke:chat] response.body is null');
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, remainder } = parseNdjson(buffer);
    buffer = remainder;
    for (const event of events) {
      if (event.type === 'delta') {
        if (ttftMs === null) ttftMs = Date.now() - startMs;
        responseChars += event.text.length;
        if (liveStream) stdout.write(event.text);
        else bufferedOutput += event.text;
      } else if (event.type === 'done') {
        sawDone = true;
      } else if (event.type === 'error') {
        errorMessage = event.message;
      }
    }
  }
  // Flush any trailing fragment.
  buffer += decoder.decode();
  const trailing = parseNdjson(buffer);
  for (const event of trailing.events) {
    if (event.type === 'delta') {
      if (ttftMs === null) ttftMs = Date.now() - startMs;
      responseChars += event.text.length;
      if (liveStream) stdout.write(event.text);
      else bufferedOutput += event.text;
    } else if (event.type === 'done') {
      sawDone = true;
    } else if (event.type === 'error') {
      errorMessage = event.message;
    }
  }

  if (!liveStream) {
    stdout.write(bufferedOutput);
  }
  stdout.write('\n');

  const totalMs = Date.now() - startMs;

  // Drain background work (Langfuse flush, chat-log write) so traces
  // land before the process exits.
  if (backgroundPromises.length > 0) {
    await Promise.allSettled(backgroundPromises);
  }

  console.log();
  console.log('--- summary ---');
  console.log(`status:         ${response.status}`);
  console.log(`stream done:    ${sawDone}`);
  console.log(`total:          ${totalMs}ms`);
  console.log(`ttft:           ${ttftMs ?? '-'}ms`);
  console.log(`response chars: ${responseChars}`);
  console.log(`started at:     ${startedAt.toISOString()}`);
  if (errorMessage) {
    console.log(`error:          ${errorMessage}`);
  }
  // No reliable script-side rag_retrieved signal — the metadata is in
  // Langfuse only. Operator infers tool firing from total latency
  // (>3s usually = a tool round) and from the rag_* trace metadata in
  // Langfuse (filter by `input.q == <query>` and matching date range).
  console.log(
    'rag_retrieved:  (inspect Langfuse trace for the matching query + date)',
  );
}

main().catch((err) => {
  console.error('[smoke:chat] failed:', err);
  process.exit(1);
});
