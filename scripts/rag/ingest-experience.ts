// CLI wrapper for the experience.md ingest. Delegates to the shared
// rag/ingest pipeline, prints a single status line, exits non-zero on
// error. Use `npm run ingest` for the default multi-source ingest;
// this per-source command stays as a debugging helper.

import { ingestExperience } from '../../rag/ingest/experience.js';

async function main(): Promise<void> {
  try {
    const result = await ingestExperience();
    console.log(
      `ingest:experience ok: ${result.total_chunks} chunks, ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.tokens_embedded} tokens embedded`,
    );
  } catch (error) {
    console.error('ingest:experience failed:', error);
    process.exit(1);
  }
}

void main();
