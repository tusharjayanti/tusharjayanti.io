import { Langfuse } from 'langfuse';

let _client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    console.warn('[langfuse] env vars missing; tracing disabled');
    return null;
  }

  if (!_client) {
    // flushAt: 1 — Vercel Edge has no persistent process to batch for;
    // flush every event immediately so nothing is lost when the function
    // instance is suspended.
    _client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 1,
    });
  }
  return _client;
}

// Test-only: drop the cached singleton so the next getLangfuse() call
// re-runs the env-var check and constructor. Not used in production.
export function __resetLangfuseForTests(): void {
  _client = null;
}
