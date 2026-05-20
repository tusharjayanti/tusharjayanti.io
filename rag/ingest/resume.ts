// Per-source wrapper. Pins the filePath / source / source_id triple for
// the resume corpus and delegates to the shared ingest pipeline.

import { ingestMarkdownSource, type IngestResult } from './markdown.js';

export async function ingestResume(): Promise<IngestResult> {
  return ingestMarkdownSource({
    filePath: 'content/resume.md',
    source: 'resume',
    source_id: 'resume.md',
  });
}
