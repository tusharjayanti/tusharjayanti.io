#!/usr/bin/env node
// Reads api/_systemPrompt.txt, generates a per-deploy canary token,
// substitutes the {{CANARY_TOKEN}} placeholder, and writes
// api/_systemPrompt.ts with the inlined content + canary export.
// Runs automatically via npm `predev` / `prebuild` hooks.
//
// CANARY_TOKEN env var overrides generation when set (intended for
// local stability — without it, every dev run rotates the canary and
// produces a noisy git diff on _systemPrompt.ts).

import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export function generateCanary() {
  return `cnry_${randomBytes(8).toString('hex')}`;
}

export function substituteCanary(text, canary) {
  return text.split('{{CANARY_TOKEN}}').join(canary);
}

export function getCanary() {
  return process.env.CANARY_TOKEN || generateCanary();
}

export function renderTs(canary, raw) {
  return (
    `// AUTO-GENERATED — DO NOT EDIT. Source: _systemPrompt.txt. Run \`npm run sync:prompt\`.\n\n` +
    `export const CANARY_TOKEN: string = ${JSON.stringify(canary)};\n\n` +
    `export const systemPrompt: string = ${JSON.stringify(raw)};\n`
  );
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

  await writeFile(OUT, renderTs(canary, substituted), 'utf-8');
  console.log(
    `[sync-prompt] wrote ${OUT} (canary ${canary}, ${substituted.length} chars)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
