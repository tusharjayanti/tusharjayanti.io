// Default ingest entry point — runs every markdown source in sequence.
// Add new sources to SOURCES below. Fails fast: if a source ingest
// throws, subsequent sources don't run and the error propagates to the
// caller.

import { DOCS_SOURCES } from './docs.js';
import {
  ingestMarkdownSource,
  type IngestOptions,
  type IngestResult,
} from './markdown.js';

const SOURCES: IngestOptions[] = [
  {
    filePath: 'content/experience.md',
    source: 'experience',
    source_id: 'experience.md',
  },
  {
    filePath: 'content/resume.md',
    source: 'resume',
    source_id: 'resume.md',
  },
  ...DOCS_SOURCES,
];

export type AllIngestResult = {
  source: string;
  source_id: string;
  result: IngestResult;
};

export async function ingestAll(): Promise<AllIngestResult[]> {
  const results: AllIngestResult[] = [];
  for (const opts of SOURCES) {
    const result = await ingestMarkdownSource(opts);
    results.push({ source: opts.source, source_id: opts.source_id, result });
  }
  return results;
}
