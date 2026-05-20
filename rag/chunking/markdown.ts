// Markdown chunker for the experience.md corpus. Walks lines, tracking
// the current H2 (company/role) and H3 (contribution bucket) headings,
// and emits one chunk per H3 with its body — prefixed by the H2 text
// (plain) and the H3 heading (as a "## " line) to give the embedder
// parent context for retrieval. H1 is ignored (document title); H4+,
// '---' rules, and blank lines inside the body are treated as body
// content. Headings with no body are dropped. Token estimation is
// chars/4 (no real tokenizer dep). When a chunk exceeds 500 estimated
// tokens, the body is split on paragraph boundaries; paragraphs are
// not subdivided and no overlap is added (M2.2 retrieval quality will
// tell us if either is needed).

export type MarkdownChunk = {
  chunk_index: number;
  content: string;
  metadata: {
    h2_heading: string;
    h3_heading: string;
    token_count: number;
  };
};

const MAX_CHUNK_TOKENS = 500;

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

function splitParagraphs(bodyLines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of bodyLines) {
    if (isBlank(line)) {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join('\n'));
  return paragraphs;
}

// Greedy paragraph packing: accumulate paragraphs into a chunk until
// adding the next would exceed MAX_CHUNK_TOKENS, then start a new chunk.
// A single oversized paragraph is emitted alone (we never split inside
// a paragraph). The H2 + H3 prefix is repeated on every emitted chunk.
function packParagraphs(
  paragraphs: string[],
  h2: string,
  h3: string,
): string[] {
  const prefix = `${h2}\n## ${h3}\n`;
  const prefixTokens = estimateTokens(prefix);
  const separator = '\n\n';
  const separatorTokens = estimateTokens(separator);

  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = prefixTokens;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    const sep = current.length > 0 ? separatorTokens : 0;
    if (
      current.length > 0 &&
      currentTokens + sep + paraTokens > MAX_CHUNK_TOKENS
    ) {
      out.push(prefix + current.join(separator));
      current = [para];
      currentTokens = prefixTokens + paraTokens;
    } else {
      current.push(para);
      currentTokens += sep + paraTokens;
    }
  }
  if (current.length > 0) out.push(prefix + current.join(separator));
  return out;
}

export function chunkMarkdown(markdown: string): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const chunks: MarkdownChunk[] = [];
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
    for (const content of packParagraphs(paragraphs, currentH2, currentH3)) {
      chunks.push({
        chunk_index: chunkIndex++,
        content,
        metadata: {
          h2_heading: currentH2,
          h3_heading: currentH3,
          token_count: estimateTokens(content),
        },
      });
    }
  }

  for (const line of lines) {
    if (line.startsWith('# ')) {
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
  return chunks;
}
