// Haiku contextual summary generator for README sliding-window
// chunks. Sub-spec 2's job: produce a 100–200 char plain-prose
// summary of each chunk given its immediate neighbors (prev + next),
// to be prepended to the chunk content as `embedding_text`. The
// embedding then carries section context the chunk body alone lacks
// (sliding-window chunks have no heading-path metadata, so the
// summary IS the context).
//
// Edge chunks (first or last in their source) get one neighbor only.
// The Anthropic SDK is already a project dep via api/chat.ts; this
// module is a thin caller around `anthropic.messages.create` with a
// strict system prompt that bans markdown, quotes, and preambles.
//
// Tracing: if `langfuse` env vars are set, wrap each call in a
// generation span tagged with repo + chunk_order so backfill cost is
// observable from the Langfuse UI. Silent on missing creds — backfill
// shouldn't fail when Langfuse is unconfigured.

import Anthropic from '@anthropic-ai/sdk';

import { getLangfuse } from '../../api/_langfuse.js';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
// Char cap is now a safety net: max_tokens does the real length
// shaping. 55 tokens ≈ 165–220 chars at typical English density, so
// the boundary-aware truncator below rarely fires under this design.
// Previous version used max_tokens=80 + an explicit "100-200 character"
// prompt instruction, which the model treated as soft — 76% of outputs
// (31/41) ran past the 200-char cap and got hard-truncated. Per the
// santifer pattern, we lean on the model's tokenizer to constrain
// length instead of asking the model to count characters.
export const SUMMARY_MAX_CHARS = 200;
export const SUMMARY_MAX_TOKENS = 55;

const SYSTEM_PROMPT = `Write one tight sentence summarizing this chunk's content in the context of the surrounding chunks. Be specific about what information this chunk contains.

Output rules:
- Plain prose only. No markdown formatting (no bold, no bullets, no headings).
- No surrounding quotes or backticks.
- No preamble ("This chunk describes...", "The text covers..."). Start with the substance.
- Voice: factual, third-person, like a librarian's blurb.`;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export type SummarizeInput = {
  prev: string | null;
  current: string;
  next: string | null;
  repo?: string;
  chunkOrder?: number;
};

export type SummarizeResult = {
  summary: string;
  inputTokens: number;
  outputTokens: number;
};

function buildUserMessage(opts: SummarizeInput): string {
  const prev =
    opts.prev !== null && opts.prev.length > 0
      ? opts.prev
      : '(none — this is the first chunk)';
  const next =
    opts.next !== null && opts.next.length > 0
      ? opts.next
      : '(none — this is the last chunk)';
  return [
    'PREVIOUS CHUNK:',
    prev,
    '',
    'CHUNK TO SUMMARIZE:',
    opts.current,
    '',
    'NEXT CHUNK:',
    next,
    '',
    'Output a 100-200 character plain-prose summary of the chunk to summarize. No preamble, no markdown, no quotes.',
  ].join('\n');
}

// Strip surrounding quotes / backticks / whitespace, collapse internal
// whitespace runs, then bound the length at SUMMARY_MAX_CHARS while
// preferring a sentence-boundary cut over a mid-word one.
//
// Truncation cascade:
//   1. last `.!?` followed by whitespace or end-of-slice within first 200 chars
//   2. last whitespace within first 200 chars (word boundary fallback)
//   3. hard char cap (last resort — only when the model emits a
//      single 200+ char unspaced token, which is pathological)
function normalizeSummary(raw: string): string {
  let text = raw.trim();
  // Strip wrapping quotes if any.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Collapse internal whitespace runs to single spaces (newlines too).
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > SUMMARY_MAX_CHARS) {
    text = truncateAtBoundary(text);
  }
  return text;
}

function truncateAtBoundary(text: string): string {
  const slice = text.slice(0, SUMMARY_MAX_CHARS);
  // Last sentence boundary in the slice: `.`, `!`, or `?` immediately
  // followed by whitespace OR sitting at the very end of the slice
  // (the latter covers a summary that fits perfectly into 200 chars).
  const sentenceMatches = [...slice.matchAll(/[.!?](?=\s|$)/g)];
  if (sentenceMatches.length > 0) {
    const lastMatch = sentenceMatches[sentenceMatches.length - 1];
    const cutAt = (lastMatch.index ?? 0) + 1;
    return slice.slice(0, cutAt);
  }
  // Word-boundary fallback: cut at the last whitespace in the slice.
  const lastSpaceIdx = slice.lastIndexOf(' ');
  if (lastSpaceIdx > 0) {
    return slice.slice(0, lastSpaceIdx);
  }
  // Pathological: a single >200 char unspaced run. Hard cap.
  return slice.trimEnd();
}

export async function summarizeChunk(
  opts: SummarizeInput,
): Promise<SummarizeResult> {
  const client = getClient();
  const userMessage = buildUserMessage(opts);

  const lf = getLangfuse();
  let generation: ReturnType<NonNullable<ReturnType<typeof getLangfuse>>['generation']> | null = null;
  try {
    generation =
      lf?.generation({
        name: 'haiku-readme-summary',
        model: HAIKU_MODEL,
        input: userMessage,
        startTime: new Date(),
        metadata: {
          repo: opts.repo ?? null,
          chunk_order: opts.chunkOrder ?? null,
        },
      }) ?? null;
  } catch (err) {
    console.error('[haiku-summary] langfuse generation create failed:', err);
  }

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Anthropic returns content as an array of blocks; for this prompt we
  // expect exactly one text block. Defensive: concatenate all text blocks.
  const rawText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const summary = normalizeSummary(rawText);

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  try {
    generation?.end({
      output: summary,
      usageDetails: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
    });
    if (lf) await lf.flushAsync();
  } catch (err) {
    console.error('[haiku-summary] langfuse generation end failed:', err);
  }

  return { summary, inputTokens, outputTokens };
}
