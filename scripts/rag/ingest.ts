// Default ingest entry point. Runs every markdown source in sequence
// via rag/ingest/all.ts, prints one status line per source. Fails fast:
// if any source throws, subsequent sources don't run.

import { ingestAll } from '../../rag/ingest/all.js';

async function main(): Promise<void> {
  try {
    const results = await ingestAll();
    for (const { source, result } of results) {
      console.log(
        `ingest:${source} ok: ${result.total_chunks} chunks, ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.tokens_embedded} tokens embedded`,
      );
    }
  } catch (error) {
    console.error('ingest failed:', error);
    process.exit(1);
  }
}

void main();
