// Public entry point for the chunker. Per-source dispatcher that
// routes to one of two strategies:
//
//   - hierarchical  (experience.md, resume.md) — H1/H2/H3 heading
//                   tree, one chunk per H3 with paragraph-split
//                   fallback, min-merge under same H2.
//   - sliding-window (project READMEs) — byte-budget windows with
//                   150-char overlap, paragraph-preferred breaks,
//                   atomic code fences. Used in the README ingest
//                   path.
//
// `MarkdownChunk` unifies both strategies' output for the ingest
// pipeline. The `metadata` field intentionally widens past the
// hierarchical-only `{h2_heading, h3_heading, token_count}` so the
// chunks table can hold both shapes — `token_count` is the only
// always-present key. Callers that need strategy-specific metadata
// (e.g., the tool_result formatter that prints `h2 > h3`) read
// optional fields and fall back to neutral labels.

import type { ChunkSource } from '../../api/_supabase.js';

import { chunkHierarchical, type HierarchicalChunk } from './hierarchical.js';
import {
  chunkSlidingWindow,
  type SlidingWindowChunk,
} from './sliding-window.js';

export type MarkdownChunk = {
  chunk_index: number;
  content: string;
  embedding_text: string;
  metadata: Record<string, unknown> & { token_count: number };
};

export type { HierarchicalChunk, SlidingWindowChunk };
export { chunkHierarchical, chunkSlidingWindow };

export function chunkMarkdown(
  content: string,
  source: ChunkSource,
): MarkdownChunk[] {
  switch (source) {
    case 'experience':
    case 'resume':
      return chunkHierarchical(content);
    case 'readme':
    case 'docs':
      // Sliding-window for docs: hierarchical would silently drop H2-only
      // content (every ADR's Context/Decision/Consequences, all of
      // privacy.md). README ingest uses the same primitive but goes
      // through ingestReadme for the Haiku summary; docs are first-party
      // content and skip the summary, calling ingestMarkdownSource directly.
      return chunkSlidingWindow(content);
    default: {
      const _exhaustive: never = source;
      throw new Error(`unknown chunk source: ${String(_exhaustive)}`);
    }
  }
}
