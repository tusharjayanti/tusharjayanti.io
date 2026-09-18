import { initTracing, flushTracing } from './_otel.js';

export { initTracing, flushTracing };

// Prompt linkage handle for generation observations.
//
// On SDK v3 this had to be cast through `unknown` to a
// `LangfusePromptClient`, because the only public type was the full client
// returned by an API call. v5 types the `prompt` attribute as a plain
// `{ name, version, isFallback }` object, so the stub is now well-typed and
// still needs no runtime Langfuse call — the version number is baked in at
// build time by scripts/sync-prompt.mjs.
//
// Returns null when no real Langfuse version is available (versionNumber
// <= 0) — happens locally without LANGFUSE_* env vars or if the build-time
// push failed. The handler then omits the prompt linkage rather than
// sending a bogus reference.
export type PromptHandle = {
  name: string;
  version: number;
  isFallback: boolean;
};

export function makeSystemPromptHandle(
  name: string,
  versionNumber: number,
): PromptHandle | null {
  if (!versionNumber || versionNumber <= 0) return null;
  return { name, version: versionNumber, isFallback: false };
}
