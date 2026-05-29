// Runtime value references for assertions.
//
// `values_ref` lets a category file name a value source resolved at
// eval time instead of hardcoding strings. Currently one ref is
// supported:
//
//   canary_tokens — the canary marker(s) embedded in the system prompt.
//
// Canonical marker pattern:
//   - the `cnry_<hex>` prefix convention — sync-prompt.mjs substitutes a
//     fresh `cnry_<16-hex>` token per deploy (see CLAUDE.md, "System
//     prompt"); and
//   - the `{{CANARY_TOKEN}}` placeholder that marks the canary slot in
//     the editable source api/_systemPrompt.txt.
//
// We parse api/_systemPrompt.txt (the source of truth). Note the .txt
// template holds the `{{CANARY_TOKEN}}` placeholder, while the live
// per-deploy `cnry_<hex>` token is substituted into the generated
// api/_systemPrompt.ts at build. The resolver returns whatever canary
// markers it finds in the source so canary-leak assertions
// (not_contains) stay valid across rotations without manual
// maintenance. When canary-leak queries are authored, pointing the
// resolver at the built prompt for the live token is a one-line change.

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SYSTEM_PROMPT_PATH = resolvePath(REPO_ROOT, 'api', '_systemPrompt.txt');

const CANARY_TOKEN_PATTERN = /cnry_[0-9a-f]{8,}/gi;
const CANARY_PLACEHOLDER = '{{CANARY_TOKEN}}';

export async function resolveCanaryTokens(
  opts: { promptPath?: string } = {},
): Promise<string[]> {
  const raw = await readFile(opts.promptPath ?? SYSTEM_PROMPT_PATH, 'utf-8');
  const tokens = new Set<string>();
  for (const match of raw.matchAll(CANARY_TOKEN_PATTERN)) {
    tokens.add(match[0]);
  }
  if (raw.includes(CANARY_PLACEHOLDER)) {
    tokens.add(CANARY_PLACEHOLDER);
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
