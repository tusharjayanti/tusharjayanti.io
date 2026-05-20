// CLI wrapper for the experience.md ingest. Reads the corpus from disk,
// calls ingestExperience, prints a single status line, exits non-zero on
// error. Path resolution is anchored to this file's location (via
// import.meta.url) so the script runs the same from any cwd.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestExperience } from '../rag/ingest/experience.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, '..', 'content', 'experience.md');

async function main(): Promise<void> {
  const markdown = await readFile(CORPUS_PATH, 'utf-8');
  const result = await ingestExperience(markdown);
  console.log(
    `ingest:experience ok: ${result.total_chunks} chunks, ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.tokens_embedded} tokens embedded`,
  );
}

main().catch((err) => {
  console.error('ingest:experience failed:', err);
  process.exit(1);
});
