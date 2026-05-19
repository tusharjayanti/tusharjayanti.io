#!/usr/bin/env node
// Reads api/_systemPrompt.txt, generates a per-deploy canary token,
// substitutes the {{CANARY_TOKEN}} placeholder, computes a content
// hash, optionally pushes the prompt to Langfuse's prompt registry
// (if LANGFUSE_* env vars are set), and writes api/_systemPrompt.ts
// with the inlined content + canary + version exports.
// Runs automatically via npm `predev` / `prebuild` hooks.
//
// CANARY_TOKEN env var overrides generation when set (intended for
// local stability — without it, every dev run rotates the canary and
// produces a noisy git diff on _systemPrompt.ts).

import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const PROMPT_NAME = 'tarvis-system-prompt';

export function generateCanary() {
  return `cnry_${randomBytes(8).toString('hex')}`;
}

export function substituteCanary(text, canary) {
  return text.split('{{CANARY_TOKEN}}').join(canary);
}

export function getCanary() {
  return process.env.CANARY_TOKEN || generateCanary();
}

// Replace the canary line with a stable placeholder so the hash tracks
// actual prompt evolution and not per-deploy canary rotation. Works on
// both the raw template (canary: {{CANARY_TOKEN}}) and the substituted
// body (canary: cnry_<hex>) — either normalizes to the same form.
function normalizeForHash(text) {
  return text.replace(/^canary:.*$/m, 'canary: <PLACEHOLDER>');
}

// SHA-256 prefix, 12 hex chars. Deterministic: same canary-normalized
// content ⇒ same hash. Used as the Langfuse label and as PROMPT_VERSION
// in the generated TS.
export function computePromptHash(text) {
  return createHash('sha256')
    .update(normalizeForHash(text), 'utf-8')
    .digest('hex')
    .slice(0, 12);
}

export function renderTs(canary, raw, promptVersion, promptVersionNumber) {
  return (
    `// AUTO-GENERATED — DO NOT EDIT. Source: _systemPrompt.txt. Run \`npm run sync:prompt\`.\n\n` +
    `export const CANARY_TOKEN: string = ${JSON.stringify(canary)};\n\n` +
    `export const PROMPT_NAME: string = ${JSON.stringify(PROMPT_NAME)};\n\n` +
    `export const PROMPT_VERSION: string = ${JSON.stringify(promptVersion)};\n\n` +
    `// Langfuse-assigned integer version. 0 when the build did not push to\n` +
    `// Langfuse (env vars missing or push failed); chat.ts skips prompt\n` +
    `// linkage when 0 instead of sending a bogus reference.\n` +
    `export const PROMPT_VERSION_NUMBER: number = ${JSON.stringify(promptVersionNumber)};\n\n` +
    `export const systemPrompt: string = ${JSON.stringify(raw)};\n`
  );
}

// Push the prompt to Langfuse if env vars are present. Dedupes by label:
// if a prompt with this hash already exists for PROMPT_NAME, reuses its
// version number instead of creating a duplicate. Returns the integer
// version (0 on any failure, env-missing, or no-op skip).
async function pushToLangfuse(promptBody, hash) {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) {
    console.warn('[sync-prompt] LANGFUSE_* env vars not set; skipping Langfuse push');
    return 0;
  }

  let Langfuse;
  try {
    ({ Langfuse } = await import('langfuse'));
  } catch (err) {
    console.warn('[sync-prompt] langfuse SDK not installed; skipping push:', err.message);
    return 0;
  }

  const lf = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 1 });

  try {
    const existing = await lf.getPrompt(PROMPT_NAME, undefined, {
      label: hash,
      cacheTtlSeconds: 0,
    });
    console.log(
      `[sync-prompt] Langfuse version exists: ${PROMPT_NAME} @ ${hash} (v${existing.version})`,
    );
    await lf.flushAsync();
    return existing.version;
  } catch {
    // getPrompt throws on 404 (no version with this label). Fall through to create.
  }

  try {
    const created = await lf.createPrompt({
      name: PROMPT_NAME,
      type: 'text',
      prompt: promptBody,
      labels: [hash],
    });
    console.log(
      `[sync-prompt] pushed to Langfuse: ${PROMPT_NAME} @ ${hash} (v${created.version})`,
    );
    await lf.flushAsync();
    return created.version;
  } catch (err) {
    console.warn('[sync-prompt] Langfuse push failed (non-fatal):', err.message);
    try {
      await lf.flushAsync();
    } catch {
      /* swallow */
    }
    return 0;
  }
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(__dirname, '..', 'api', '_systemPrompt.txt');
  const OUT = resolve(__dirname, '..', 'api', '_systemPrompt.ts');

  const template = await readFile(SRC, 'utf-8');
  const canary = getCanary();
  const substituted = substituteCanary(template, canary);

  // Defense-in-depth: assert post-substitution shape matches the
  // expected "canary: <token>" line. Catches a malformed template
  // (e.g. someone hand-edited the .txt and broke the first line).
  const firstLine = substituted.split('\n', 1)[0].trim();
  const match = firstLine.match(/^canary:\s*(\S+)\s*$/);
  if (!match || match[1] !== canary) {
    console.error(
      `[sync-prompt] ERROR: ${SRC}: first line must be "canary: {{CANARY_TOKEN}}". After substitution got: ${JSON.stringify(firstLine)}`,
    );
    process.exit(1);
  }

  // The hash is canary-normalized (see computePromptHash) so per-deploy
  // canary rotation does not spawn a new Langfuse version. The push body
  // still carries the real substituted canary so the registry mirrors
  // production content.
  const promptVersion = computePromptHash(substituted);
  const promptVersionNumber = await pushToLangfuse(substituted, promptVersion);

  await writeFile(
    OUT,
    renderTs(canary, substituted, promptVersion, promptVersionNumber),
    'utf-8',
  );
  console.log(
    `[sync-prompt] wrote ${OUT} (canary ${canary}, ${substituted.length} chars, version ${promptVersion})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
