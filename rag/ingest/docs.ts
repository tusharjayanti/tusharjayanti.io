// Docs source list — first-party engineering writeups (docs/rag.md,
// docs/observability.md, docs/privacy.md) + ADRs (docs/decisions/*.md).
// Ingested via the generic ingestMarkdownSource path (sliding-window
// chunking, no Haiku summary). source_id = full repo-relative path,
// which keeps the two `0001-...md` ADRs distinguishable.
//
// demo.gif is intentionally excluded — binary, not markdown. Any future
// docs/ markdown file added must be registered here explicitly; ingest
// does not auto-discover files under docs/.

import type { IngestOptions } from './markdown.js';

export const DOCS_SOURCES: IngestOptions[] = [
  {
    filePath: 'docs/rag.md',
    source: 'docs',
    source_id: 'docs/rag.md',
  },
  {
    filePath: 'docs/observability.md',
    source: 'docs',
    source_id: 'docs/observability.md',
  },
  {
    filePath: 'docs/privacy.md',
    source: 'docs',
    source_id: 'docs/privacy.md',
  },
  {
    filePath: 'docs/decisions/0001-observability-foundation.md',
    source: 'docs',
    source_id: 'docs/decisions/0001-observability-foundation.md',
  },
  {
    filePath: 'docs/decisions/0001-reranker-temperature.md',
    source: 'docs',
    source_id: 'docs/decisions/0001-reranker-temperature.md',
  },
  {
    filePath: 'docs/decisions/0002-agentic-rag.md',
    source: 'docs',
    source_id: 'docs/decisions/0002-agentic-rag.md',
  },
];
