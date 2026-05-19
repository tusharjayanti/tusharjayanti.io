import { Langfuse, type LangfusePromptClient } from 'langfuse';

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

// Build a minimal prompt handle for trace.generation({ prompt }) linkage
// without making a runtime API call. The Langfuse SDK only reads .name and
// .version off the handle when building the wire payload, so a local stub
// is enough to wire generations to a registered prompt version.
//
// Returns null when no real Langfuse version is available (versionNumber
// <= 0) — happens locally without LANGFUSE_* env vars or if the build-time
// push failed. The handler then omits the prompt linkage rather than
// sending a bogus reference.
export function makeSystemPromptHandle(
  name: string,
  versionNumber: number,
): LangfusePromptClient | null {
  if (!versionNumber || versionNumber <= 0) return null;
  return {
    name,
    version: versionNumber,
    isFallback: false,
  } as unknown as LangfusePromptClient;
}

// Test-only: drop the cached singleton so the next getLangfuse() call
// re-runs the env-var check and constructor. Not used in production.
export function __resetLangfuseForTests(): void {
  _client = null;
}
