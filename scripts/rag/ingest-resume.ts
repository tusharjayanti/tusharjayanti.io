// CLI wrapper for the resume.md ingest. Delegates to the shared
// rag/ingest pipeline, prints a single status line, exits non-zero on
// error. Use `npm run ingest` for the default multi-source ingest;
// this per-source command stays as a debugging helper.

import { ingestResume } from '../../rag/ingest/resume.js';

async function main(): Promise<void> {
  try {
    const result = await ingestResume();
    console.log(
      `ingest:resume ok: ${result.total_chunks} chunks, ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.tokens_embedded} tokens embedded`,
    );
  } catch (error) {
    console.error('ingest:resume failed:', error);
    process.exit(1);
  }
}

void main();
