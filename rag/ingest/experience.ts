// Per-source wrapper. Pins the filePath / source / source_id triple for
// the experience corpus and delegates to the shared ingest pipeline.

import { ingestMarkdownSource, type IngestResult } from './markdown.js';

export async function ingestExperience(): Promise<IngestResult> {
  return ingestMarkdownSource({
    filePath: 'content/experience.md',
    source: 'experience',
    source_id: 'experience.md',
  });
}
