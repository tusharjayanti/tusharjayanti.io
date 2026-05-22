// M2.7 — Haiku listwise reranker with binary relevance verdicts.
//
// The reranker is the sole relevance authority for retrieval. The
// cosine-similarity floor is now a cost-control pre-filter only —
// chunks that fail cosine never reach Haiku. The reranker's binary
// yes/no verdicts determine which chunks make it into tool_result;
// "no" verdicts are how out-of-corpus queries trigger the no-match
// fabrication guardrail at the production threshold (0.15) that
// M2.6.5 proved a scalar cosine threshold cannot handle alone.
//
// Pipeline (see rerankChunks below):
//
//   match_chunks (top-K=10)
//     → cosine pre-filter at RAG_MIN_COSINE_SIMILARITY (default 0.15)
//     → if ≤3 survivors: skip Haiku, diversify, return
//     → else: seeded shuffle → Haiku listwise verdict
//     → drop "no" verdicts
//     → if zero survive: caller emits NO_MATCH_TOOL_RESULT
//     → else: santifer two-pass diversification → top-N=5
//
// Failure mode: any Haiku error (timeout, parse failure, 5xx) →
// log + fall back to the top-N slice of the pre-filtered list
// (diversified). Never throw; never block the user request.

import Anthropic from '@anthropic-ai/sdk';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_COSINE_PRE_FILTER = 0.15;
export const DEFAULT_RERANK_K = 10;
export const DEFAULT_RERANK_N = 5;
export const DEFAULT_SKIP_RERANK_BELOW = 3;
export const MAX_CHUNK_CHARS = 200;
export const HAIKU_MAX_TOKENS = 80;

const SYSTEM_PROMPT = `You are a relevance judge. For each candidate chunk, decide whether it materially answers the query.

Be strict:
- A chunk that mentions the same project or person but addresses a DIFFERENT topic from the query is "no".
- A chunk that is the same general subject but doesn't contain the SPECIFIC information asked is "no".
- A chunk is "yes" only when its content directly answers what the query is asking.

For each chunk, output exactly one pair in the form <id>:<yes|no>, comma-separated, no explanation, no other text.

Example output: 1:yes, 2:no, 3:yes, 4:no, 5:no, 6:yes`;

export type Verdict = 'yes' | 'no';

export interface RerankerCandidate {
  source_id: string;
  chunk_index: number;
  content: string;
  semantic_distance: number | null;
}

// Used by callers that want to thread additional metadata through
// the reranker without losing it. The reranker preserves order
// fields and rank from its judging output, but the caller's payload
// rides through unchanged.
export type WithCandidate<T> = T & RerankerCandidate;

export interface RerankOpts {
  cosinePreFilter?: number;
  topN?: number;
  skipBelow?: number;
  // Test injection — supply a fake judge to avoid hitting Anthropic.
  judge?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

function getEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// SHA-256 of the query, first 4 bytes as a 32-bit unsigned integer.
// Deterministic seed for the shuffle — same query produces the same
// shuffle order across runs so the eval suite is reproducible.
export async function seedFromQuery(query: string): Promise<number> {
  const bytes = new TextEncoder().encode(query);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new DataView(digest);
  return view.getUint32(0, false);
}

// mulberry32 PRNG. Cheap, deterministic, good enough for shuffling
// 10 items. Not cryptographic; we only need it to be reproducible
// given a seed.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Parse Haiku's listwise output. Expected format:
//   "1:yes, 3:yes, 7:no, 2:yes, 5:no, 4:yes"
//
// Returns a map of <id> -> 'yes' | 'no'. IDs sent to Haiku but absent
// from its output are treated as "no" (conservative — we'd rather
// drop a relevant chunk than fabricate from a chunk Haiku skipped).
// Malformed pairs are logged and treated as "no".
export function parseRerankerOutput(
  output: string,
  sentIds: number[],
): Map<number, Verdict> {
  const result = new Map<number, Verdict>();
  for (const id of sentIds) result.set(id, 'no');
  if (!output || typeof output !== 'string') return result;
  const pairs = output.split(',');
  for (const raw of pairs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const m = /^\[?(\d+)\]?\s*:\s*(yes|no)\s*$/i.exec(trimmed);
    if (!m) {
      console.warn('[rerank] malformed pair, treating as no:', trimmed);
      continue;
    }
    const id = Number.parseInt(m[1]!, 10);
    const verdict = m[2]!.toLowerCase() as Verdict;
    if (!sentIds.includes(id)) {
      console.warn('[rerank] verdict for unsent id, ignoring:', id);
      continue;
    }
    result.set(id, verdict);
  }
  return result;
}

// Santifer's two-pass diversification:
//   1. First pass: pick the top-ranked chunk from each distinct
//      source_id (preserves rank order within the pick set).
//   2. Second pass: fill remaining slots from the unused chunks in
//      rank order.
// Caller is responsible for the rank order of `chunks` going in.
export function diversifyByPass<T extends RerankerCandidate>(
  chunks: T[],
  n: number,
): T[] {
  if (n <= 0 || chunks.length === 0) return [];
  const picked: T[] = [];
  const seenSources = new Set<string>();
  // Pass 1
  for (const c of chunks) {
    if (picked.length >= n) break;
    if (seenSources.has(c.source_id)) continue;
    picked.push(c);
    seenSources.add(c.source_id);
  }
  if (picked.length >= n) return picked;
  // Pass 2 — fill remaining slots in rank order from chunks not
  // already picked.
  for (const c of chunks) {
    if (picked.length >= n) break;
    if (picked.includes(c)) continue;
    picked.push(c);
  }
  return picked;
}

let _anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

// Default judge wraps the Anthropic SDK. Tests inject a fake via
// RerankOpts.judge so they never touch the network.
async function defaultJudge(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const client = getClient();
  const res = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: HAIKU_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  // Anthropic returns content blocks; we want concatenated text.
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
  return text;
}

function buildUserPrompt(query: string, items: Array<{ id: number; content: string }>): string {
  const chunkLines = items
    .map((it) => {
      const c = it.content.length > MAX_CHUNK_CHARS
        ? it.content.slice(0, MAX_CHUNK_CHARS).trimEnd() + '…'
        : it.content;
      return `[${it.id}] ${c}`;
    })
    .join('\n');
  return `Query: ${query}\n\nChunks:\n${chunkLines}\n\nOutput:`;
}

export async function rerankChunks<T extends RerankerCandidate>(
  query: string,
  chunks: T[],
  opts: RerankOpts = {},
): Promise<T[]> {
  const cosineMin = opts.cosinePreFilter ?? getEnvFloat('RAG_MIN_COSINE_SIMILARITY', DEFAULT_COSINE_PRE_FILTER);
  const topN = opts.topN ?? getEnvInt('RAG_RERANK_N', DEFAULT_RERANK_N);
  const skipBelow = opts.skipBelow ?? DEFAULT_SKIP_RERANK_BELOW;
  const judge = opts.judge ?? defaultJudge;

  // Step 1: cosine pre-filter. Drops obvious off-topic noise before
  // we pay for Haiku. Chunks with null semantic_distance (BM25-only
  // hits) are dropped — same logic as the production guardrail
  // before M2.7.
  const preFiltered = chunks.filter((c) => {
    if (c.semantic_distance === null) return false;
    return 1 - c.semantic_distance >= cosineMin;
  });

  if (preFiltered.length === 0) {
    return [];
  }

  // Step 2: skip-condition. With ≤3 candidates the listwise prompt
  // has nothing to rerank against; diversify and return.
  if (preFiltered.length <= skipBelow) {
    return diversifyByPass(preFiltered, topN);
  }

  // Step 3: seeded shuffle. Mitigates Haiku's mild low-index bias
  // without needing multi-pass averaging at K=10.
  const seed = await seedFromQuery(query);
  // Assign each chunk a stable 1-based id BEFORE shuffling so
  // verdicts map back to candidates by id, not by post-shuffle
  // position.
  const indexed = preFiltered.map((chunk, i) => ({ id: i + 1, chunk }));
  const shuffled = seededShuffle(indexed, seed);

  // Step 4: Haiku verdict.
  const userPrompt = buildUserPrompt(
    query,
    shuffled.map((s) => ({ id: s.id, content: s.chunk.content })),
  );
  let rawOutput: string;
  try {
    rawOutput = await judge(SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    // Graceful fallback (same philosophy as the M2.8 cache lock):
    // log, never throw to the caller, return the pre-filter top-N
    // diversified so retrieval still functions during a Haiku
    // outage.
    console.error('[rerank] judge call failed, falling back:', err);
    return diversifyByPass(preFiltered, topN);
  }

  const sentIds = shuffled.map((s) => s.id);
  const verdicts = parseRerankerOutput(rawOutput, sentIds);

  // Step 5: drop "no" verdicts. Preserve original rank order (the
  // pre-filtered list's order) for the survivors — the post-Haiku
  // ordering uses the underlying RRF rank, not Haiku's emit order.
  const survived: T[] = [];
  for (const c of preFiltered) {
    const slot = indexed.find((it) => it.chunk === c);
    if (!slot) continue;
    if (verdicts.get(slot.id) === 'yes') survived.push(c);
  }

  if (survived.length === 0) {
    return [];
  }

  return diversifyByPass(survived, topN);
}

// Test-only: reset the cached Anthropic client between tests.
export function __resetRerankerForTests(): void {
  _anthropic = null;
}
