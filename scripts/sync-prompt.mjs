#!/usr/bin/env node
// Reads api/_systemPrompt.txt, validates the canary line, and writes
// api/_systemPrompt.ts with the content inlined. Runs automatically via
// npm `predev` / `prebuild` hooks so the generated file is always fresh.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'api', '_systemPrompt.txt');
const OUT = resolve(__dirname, '..', 'api', '_systemPrompt.ts');

const raw = await readFile(SRC, 'utf-8');
const firstLine = raw.split('\n', 1)[0].trim();
const canaryMatch = firstLine.match(/^canary:\s*(\S+)\s*$/);
if (!canaryMatch) {
  console.error(
    `[sync-prompt] ERROR: ${SRC}: first line must be "canary: <token>". Got: ${JSON.stringify(firstLine)}`,
  );
  process.exit(1);
}
const canary = canaryMatch[1];

const out =
  `// AUTO-GENERATED — DO NOT EDIT. Source: _systemPrompt.txt. Run \`npm run sync:prompt\`.\n\n` +
  `export const CANARY_TOKEN: string = ${JSON.stringify(canary)};\n\n` +
  `export const systemPrompt: string = ${JSON.stringify(raw)};\n`;

await writeFile(OUT, out, 'utf-8');
console.log(
  `[sync-prompt] wrote ${OUT} (canary ${canary}, ${raw.length} chars)`,
);
