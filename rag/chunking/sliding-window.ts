// Sliding-window chunker for README sources. READMEs in the
// allowlist are heterogeneous in shape — some have well-structured
// H2/H3 trees (tusharjayanti.io, calculator-agent), some are H2-only
// (vox-agent), some have no headings at all (TensorflowChatbot, 1.2K
// chars of prose). The hierarchical chunker can't handle the H2-only
// and heading-free cases — it would drop them entirely. Sliding-window
// fills that gap by chunking by byte budget rather than structure.
//
// Design:
//
// - Target window size: 1500 chars. Picked after analysing the 6
//   allowlist READMEs (median ~7.5K chars, largest 26K). At 1500 chars
//   the largest README produces ~17 chunks; small READMEs produce
//   1–2. Balanced against experience.md (27) and resume.md (17) so no
//   single source dominates the corpus.
// - Overlap between consecutive windows: 150 chars (~10% of target).
//   Exists only in `embedding_text`, NOT in `content`. Content is
//   non-overlapping so display is clean; embeddings see the tail of
//   the previous window for cross-window continuity.
// - Break preference: paragraph boundaries (blank lines), then any
//   newline, then any character. Within 250 chars of the target.
// - Code fences are atomic. If a candidate break point falls inside a
//   fenced block, we extend the window to include the closing fence,
//   even if that pushes past the target. No hard cap per spec.

export type SlidingWindowChunk = {
  chunk_index: number;
  content: string;
  embedding_text: string;
  metadata: {
    start_offset: number;
    end_offset: number;
    token_count: number;
  };
};

const TARGET_CHUNK_CHARS = 1500;
const OVERLAP_CHARS = 150;
// How far past the target we'll scan for a paragraph or line break.
// Bounded so a corpus with no breaks doesn't blow the window way past
// the target.
const BREAK_SEARCH_RADIUS = 250;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Returns the index of the next `\n\n` (paragraph break) at or after
// `from`, scanning at most `maxScan` chars. Returns -1 if not found.
function findParagraphBreak(
  text: string,
  from: number,
  maxScan: number,
): number {
  const end = Math.min(text.length, from + maxScan);
  const slice = text.slice(from, end);
  const rel = slice.indexOf('\n\n');
  if (rel === -1) return -1;
  return from + rel;
}

// Returns the index of the next single `\n` (line break) at or after
// `from`, scanning at most `maxScan` chars. Returns -1 if not found.
function findLineBreak(text: string, from: number, maxScan: number): number {
  const end = Math.min(text.length, from + maxScan);
  const slice = text.slice(from, end);
  const rel = slice.indexOf('\n');
  if (rel === -1) return -1;
  return from + rel;
}

// True if `offset` lies inside an open code fence (i.e., an odd number
// of ``` markers appear in text[0..offset]).
function insideFence(text: string, offset: number): boolean {
  let count = 0;
  let idx = 0;
  while (idx < offset) {
    const next = text.indexOf('```', idx);
    if (next === -1 || next >= offset) break;
    count++;
    idx = next + 3;
  }
  return count % 2 === 1;
}

// Find the next ``` AT OR AFTER `from`. Returns the index of the line
// terminator following the fence (so the chunk includes the closing
// ``` line). Returns text.length if no closing fence is found —
// callers treat this as "include the rest of the text".
function findFenceClose(text: string, from: number): number {
  const fenceIdx = text.indexOf('```', from);
  if (fenceIdx === -1) return text.length;
  // Find the newline after the closing fence so the fence line is
  // included whole.
  const nl = text.indexOf('\n', fenceIdx + 3);
  return nl === -1 ? text.length : nl + 1;
}

// Pick the end offset of the next window starting at `start`. The
// returned offset is exclusive — text.slice(start, end) is the window
// content.
function pickWindowEnd(text: string, start: number): number {
  const target = start + TARGET_CHUNK_CHARS;
  if (target >= text.length) {
    return text.length;
  }

  // 1. Prefer a paragraph break within the search radius.
  let candidate = findParagraphBreak(text, target, BREAK_SEARCH_RADIUS);
  // 2. Fall back to a single line break within the search radius.
  if (candidate === -1) {
    candidate = findLineBreak(text, target, BREAK_SEARCH_RADIUS);
  }
  // 3. Last resort: break at the target boundary (mid-word, ugly but
  //    bounded). This only fires when the corpus has no breaks within
  //    BREAK_SEARCH_RADIUS — pathological case.
  if (candidate === -1) {
    candidate = target;
  } else {
    // The break index is the position OF the newline; we want to
    // include up to and including that newline so the next window
    // starts on a fresh line.
    candidate += 1;
  }

  // Atomic code fences: if the candidate break would land inside an
  // open fence, extend to the closing fence.
  if (insideFence(text, candidate)) {
    candidate = findFenceClose(text, candidate);
  }
  return Math.min(candidate, text.length);
}

export function chunkSlidingWindow(text: string): SlidingWindowChunk[] {
  const out: SlidingWindowChunk[] = [];
  if (text.length === 0) return out;

  let start = 0;
  let chunkIndex = 0;
  while (start < text.length) {
    const end = pickWindowEnd(text, start);
    const content = text.slice(start, end);
    // Overlap is the last OVERLAP_CHARS of the PREVIOUS window's
    // content, prepended to this window's content for the embedding.
    // First window has no previous; embedding_text equals content.
    const prevContent = chunkIndex > 0 ? out[chunkIndex - 1].content : '';
    const overlap =
      prevContent.length > OVERLAP_CHARS
        ? prevContent.slice(prevContent.length - OVERLAP_CHARS)
        : prevContent;
    const embedding_text = chunkIndex === 0 ? content : `${overlap}${content}`;
    out.push({
      chunk_index: chunkIndex,
      content,
      embedding_text,
      metadata: {
        start_offset: start,
        end_offset: end,
        token_count: estimateTokens(content),
      },
    });
    chunkIndex++;
    start = end;
  }
  return out;
}
