// Runtime value references for assertions.
//
// `values_ref` lets a category file name a value source resolved at
// eval time instead of hardcoding strings. Currently one ref is
// supported:
//
//   canary_tokens — the live canary token(s) embedded in the BUILT
//   system prompt (api/_systemPrompt.ts). sync-prompt.mjs substitutes
//   a fresh `cnry_<16-hex>` per deploy into the generated .ts at
//   build time. The .txt template only holds the `{{CANARY_TOKEN}}`
//   placeholder, so we read the built file — placeholder matches are
//   not useful for leak-detection assertions.
//
// Fallback: if api/_systemPrompt.ts hasn't been built yet (fresh
// checkout, pre-build) or doesn't contain a canary token, the
// resolver logs a warning and returns []. Tests should not fail on a
// missing build; canary-leak assertions become vacuously true in that
// case, which is the right semantic — there is no live token to leak.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SYSTEM_PROMPT_BUILT_PATH = resolvePath(
  REPO_ROOT,
  'api',
  '_systemPrompt.ts',
);

const CANARY_TOKEN_PATTERN = /cnry_[0-9a-f]{8,}/gi;

export async function resolveCanaryTokens(
  opts: { promptPath?: string } = {},
): Promise<string[]> {
  const path = opts.promptPath ?? SYSTEM_PROMPT_BUILT_PATH;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    console.warn(
      `[refs] canary_tokens resolution: could not read ${path} ` +
        `(${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
        `Returning empty list. If this is a fresh checkout, run \`npm run sync:prompt\` ` +
        `or any \`npm run dev*\`/\`npm run build*\` to regenerate the built prompt.`,
    );
    return [];
  }
  const tokens = new Set<string>();
  for (const match of raw.matchAll(CANARY_TOKEN_PATTERN)) {
    tokens.add(match[0]);
  }
  if (tokens.size === 0) {
    console.warn(
      `[refs] canary_tokens resolution: no cnry_<hex> tokens found in ${path}. ` +
        `Returning empty list. Did sync-prompt.mjs run during the build?`,
    );
  }
  return [...tokens];
}

/** Resolve a values_ref name to concrete strings. */
export async function resolveRef(
  name: string,
  opts: { promptPath?: string } = {},
): Promise<string[]> {
  switch (name) {
    case 'canary_tokens':
      return resolveCanaryTokens(opts);
    default:
      throw new Error(`unknown values_ref: "${name}"`);
  }
}
