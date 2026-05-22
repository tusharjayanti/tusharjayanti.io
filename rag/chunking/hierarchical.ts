// Hierarchical chunker for authored sources (experience.md, resume.md).
// Walks the H1/H2/H3 heading tree and emits one chunk per H3 section
// (or per paragraph-pack when an H3 exceeds the soft cap). Two key
// changes from the pre-sub-spec-1 chunker:
//
// 1. `content` is now CLEAN — just the body text under the H3, with
//    no H2/H3 prefix. The model sees uncluttered prose in tool_result
//    blocks.
// 2. `embedding_text` is what gets embedded into the dense vector. It
//    prepends the parent H2 heading and the chunk's own H3 heading so
//    semantic retrieval picks up section context that would otherwise
//    be lost from the chunk body alone.
//
// Other invariants preserved from M2.1:
// - H1 is ignored (document title).
// - H3s with no body are dropped (no orphan-heading chunks).
// - Soft cap: H3 sections >500 estimated tokens (chars/4) split on
//   blank-line paragraph boundaries; no overlap.
// - Code fences (lines fenced by ```...```) are atomic — a paragraph
//   that opens a fence stays joined to the paragraph that closes it,
//   even if that pushes the pack above the soft cap. "No hard cap"
//   per the sub-spec.
// - Min-merge: emitted chunks whose content is shorter than 200 chars
//   merge into the previous chunk under the same H2 parent. If no
//   such sibling exists, merge forward; if neither, keep as-is.

export type HierarchicalChunk = {
  chunk_index: number;
  content: string;
  embedding_text: string;
  metadata: {
    h2_heading: string;
    h3_heading: string;
    token_count: number;
  };
};

const SOFT_CHUNK_TOKEN_CAP = 500;
// Min-merge threshold: chunks shorter than this collapse into the
// previous sibling under the same H2. Lowered from 200 → 100 after
// sub-spec 1 first-pass landed showed 37% chunk-count drop on the
// experience corpus (many H3 bodies between 100–200 chars). At 100,
// only genuinely tiny H3s merge — preserves more chunk granularity
// while still pulling fragments together.
const MIN_CHUNK_CHARS = 100;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isBlank(lines[start])) start++;
  let end = lines.length;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

// Paragraph split that respects code fences. A "paragraph" is either:
//   - a run of non-fenced, non-blank lines bounded by blank lines, OR
//   - a single fenced block ```...``` (treated atomically — never split).
// Returns the list of paragraph strings, each terminated such that
// rejoining with '\n\n' reproduces the same logical structure.
function splitParagraphs(bodyLines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let insideFence = false;

  function flushCurrent(): void {
    if (current.length === 0) return;
    paragraphs.push(current.join('\n'));
    current = [];
  }

  for (const line of bodyLines) {
    const isFenceLine = /^\s*```/.test(line);
    if (insideFence) {
      // Inside a fence: every line belongs to the current paragraph
      // regardless of blanks. The closing fence ends the fenced block
      // but stays attached to that paragraph.
      current.push(line);
      if (isFenceLine) {
        insideFence = false;
      }
      continue;
    }
    if (isFenceLine) {
      // Opening a fence — close any prose paragraph first so the
      // fenced block stands alone, then start a new paragraph that
      // contains the entire fence.
      flushCurrent();
      current.push(line);
      insideFence = true;
      continue;
    }
    if (isBlank(line)) {
      flushCurrent();
    } else {
      current.push(line);
    }
  }
  flushCurrent();
  return paragraphs;
}

// Greedy pack: accumulate paragraphs into a chunk until adding the
// next would exceed SOFT_CHUNK_TOKEN_CAP, then start a new chunk. A
// single oversized paragraph (typically a long code block) is emitted
// alone — we never split inside a paragraph.
function packParagraphs(paragraphs: string[]): string[] {
  const separator = '\n\n';
  const separatorTokens = estimateTokens(separator);

  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    const sep = current.length > 0 ? separatorTokens : 0;
    if (
      current.length > 0 &&
      currentTokens + sep + paraTokens > SOFT_CHUNK_TOKEN_CAP
    ) {
      out.push(current.join(separator));
      current = [para];
      currentTokens = paraTokens;
    } else {
      current.push(para);
      currentTokens += sep + paraTokens;
    }
  }
  if (current.length > 0) out.push(current.join(separator));
  return out;
}

// Walk the heading tree and emit chunks as a flat list, before the
// min-merge pass.
function emitRawChunks(markdown: string): HierarchicalChunk[] {
  const lines = markdown.split('\n');
  const out: HierarchicalChunk[] = [];
  let currentH2: string | null = null;
  let currentH3: string | null = null;
  let bodyLines: string[] = [];
  let chunkIndex = 0;

  function flush(): void {
    if (currentH2 === null || currentH3 === null) {
      bodyLines = [];
      return;
    }
    const trimmed = trimBlankLines(bodyLines);
    bodyLines = [];
    if (trimmed.length === 0) return;
    const paragraphs = splitParagraphs(trimmed);
    if (paragraphs.length === 0) return;
    const packs = packParagraphs(paragraphs);
    const headingPrefix = `${currentH2}\n## ${currentH3}\n`;
    for (const content of packs) {
      const embedding_text = headingPrefix + content;
      out.push({
        chunk_index: chunkIndex++,
        content,
        embedding_text,
        metadata: {
          h2_heading: currentH2,
          h3_heading: currentH3,
          token_count: estimateTokens(content),
        },
      });
    }
  }

  for (const line of lines) {
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      // H1 — document title, ignore.
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      currentH3 = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      currentH2 = line.slice(3).trim();
      currentH3 = null;
      continue;
    }
    // Body line (H4+, '---', blank, or prose).
    if (currentH3 !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  return out;
}

// Merge chunks whose content is below MIN_CHUNK_CHARS into a sibling
// under the same H2 parent. Preferred direction: backward (into the
// previous sibling). Fallback: forward (into the next sibling). If no
// sibling exists under the same H2, the chunk stays as-is.
//
// Re-indexes `chunk_index` after merges so the result is dense.
function applyMinMerge(chunks: HierarchicalChunk[]): HierarchicalChunk[] {
  if (chunks.length === 0) return chunks;
  const result: HierarchicalChunk[] = chunks.map((c) => ({ ...c }));

  // Forward pass for backward-merge: walk from index 1 upward; if the
  // current chunk is small AND the most recent LIVE previous chunk
  // shares the same H2, merge current into that previous chunk.
  // Collapse by marking current as a tombstone with empty content;
  // filter at the end.
  //
  // The "skip tombstones" walk-back matters when a sequence of small
  // siblings collapses left-to-right under the same H2. Without it,
  // the second-to-last small chunk merges into the first big one and
  // becomes a tombstone, and the last small chunk's `i-1` neighbour
  // is now empty — the loop would bail and leave it as a stranded
  // orphan (the Baanyan > Frontend 71-char bug). The forward-merge
  // pass already walks past tombstones; this makes the backward pass
  // symmetric.
  for (let i = 1; i < result.length; i++) {
    const cur = result[i];
    if (cur.content.length === 0) continue;
    if (cur.content.length >= MIN_CHUNK_CHARS) continue;
    let j = i - 1;
    while (j >= 0 && result[j].content.length === 0) j--;
    if (j < 0) continue;
    const prev = result[j];
    if (cur.metadata.h2_heading !== prev.metadata.h2_heading) continue;
    prev.content = `${prev.content}\n\n${cur.content}`;
    prev.embedding_text = `${prev.embedding_text}\n\n${cur.content}`;
    prev.metadata = {
      ...prev.metadata,
      token_count: estimateTokens(prev.content),
    };
    cur.content = '';
    cur.embedding_text = '';
  }

  // Forward-merge pass for any remaining smalls whose previous sibling
  // was a different H2 (so backward merge wasn't possible). Walk
  // descending so a small chunk can merge into the next non-tombstone
  // sibling under the same H2.
  for (let i = result.length - 2; i >= 0; i--) {
    const cur = result[i];
    if (cur.content.length === 0) continue;
    if (cur.content.length >= MIN_CHUNK_CHARS) continue;
    // Find the next non-tombstone with the same H2.
    let j = i + 1;
    while (j < result.length && result[j].content.length === 0) j++;
    if (j >= result.length) continue;
    const next = result[j];
    if (next.metadata.h2_heading !== cur.metadata.h2_heading) continue;
    next.content = `${cur.content}\n\n${next.content}`;
    next.embedding_text = `${cur.embedding_text}\n\n${next.content}`;
    next.metadata = {
      ...next.metadata,
      token_count: estimateTokens(next.content),
    };
    cur.content = '';
    cur.embedding_text = '';
  }

  // Drop tombstones and re-index.
  const compacted = result.filter((c) => c.content.length > 0);
  for (let i = 0; i < compacted.length; i++) {
    compacted[i].chunk_index = i;
  }
  return compacted;
}

export function chunkHierarchical(markdown: string): HierarchicalChunk[] {
  const raw = emitRawChunks(markdown);
  return applyMinMerge(raw);
}
