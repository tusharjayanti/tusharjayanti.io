// Anthropic tool definitions for the RAG-over-chat loop. Three
// source-scoped retrieval tools that wrap the M2.2 hybrid match_chunks
// RPC. Sonnet picks one or more per turn; the chat handler executes
// each, appends tool_result blocks, and re-prompts Sonnet for the
// final streamed answer.
//
// - search_experience (M2.4) — detailed role writeups
// - search_resume (M2.4)     — compact summaries
// - search_readme (M2.5)     — GitHub project READMEs, ingested via
//                              `ingestReadme` and refreshed on push
//                              via `/api/github-webhook`
//
// `executeTool` performs the embed + RPC round-trip per call and is the
// only callsite outside scripts/ that hits Voyage at retrieval time.

import type { LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import { embed } from './_voyage.js';
import { getSupabaseClient } from './_supabase.js';
import { fetchUrl } from './_webFetch.js';
import {
  rerankChunks,
  HAIKU_MODEL,
  HAIKU_MAX_TOKENS,
  HAIKU_TEMPERATURE,
} from './_reranker.js';

// Parent for the per-step child observations: embedding + rerank are
// generations (model calls — they carry token usageDetails), retrieval is
// a plain span (Supabase RPC, duration only). chat.ts owns the
// tool-execution span and passes it down; null when Langfuse isn't wired
// (tests, missing env).
type ToolParentSpan = LangfuseSpanClient | LangfuseGenerationClient | null;

export const SEARCH_EXPERIENCE = 'search_experience';
export const SEARCH_RESUME = 'search_resume';
export const SEARCH_README = 'search_readme';
export const FETCH_URL = 'fetch_url';

export type ToolName =
  | typeof SEARCH_EXPERIENCE
  | typeof SEARCH_RESUME
  | typeof SEARCH_README
  | typeof FETCH_URL;
type RetrievalSource = 'experience' | 'resume' | 'readme';
export type ToolSource = RetrievalSource | 'url';

const SEARCH_SOURCE_MAP: Record<
  Exclude<ToolName, typeof FETCH_URL>,
  RetrievalSource
> = {
  [SEARCH_EXPERIENCE]: 'experience',
  [SEARCH_RESUME]: 'resume',
  [SEARCH_README]: 'readme',
};

// M2.7: K=10 over-retrieve, reranker drops "no" verdicts and
// diversifies to N=5 for the final tool_result. Pre-M2.7 was K=N=3.
const MATCH_COUNT = 10;

export const TOOLS = [
  {
    name: SEARCH_EXPERIENCE,
    description:
      "Search Tushar Jayanti's experience writeups for detailed technical stories about his work at DISCO (identity platform migration, p99 latency reduction, gRPC migration), PurpleToko (0-to-1 e-commerce backend), Transcend Street Solutions (financial systems, Reserve Release feature), and Baanyan/USAA (Kafka event-driven services). Use this tool when the user asks about specific roles, technical decisions, architectural choices, or detailed engineering work. Returns the top 5 most relevant chunks after Haiku-based relevance filtering.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            "The search query — usually the user's question paraphrased to focus on the relevant work or technology.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: SEARCH_RESUME,
    description:
      "Search Tushar Jayanti's resume for compact summaries of his roles, skills, education, and projects. Use this tool when the user asks about high-level qualifications, what technologies he knows, his education, or current projects. The resume contains the elevator-pitch versions of his work; use search_experience for deeper technical stories. Returns the top 5 most relevant chunks after Haiku-based relevance filtering.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            "The search query — usually the user's question paraphrased to focus on the relevant qualifications or skills.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: SEARCH_README,
    description:
      "Search Tushar Jayanti's GitHub project READMEs for deep architecture and implementation details on his side projects (vox-agent, shortlist, tusharjayanti.io, calculator-agent, TensorflowChatbot, OpticalCharacterRecognition). Use this tool when the user asks how a specific project works internally, what its design decisions were, or for technical depth beyond what the resume covers. Returns the top 5 most relevant chunks after Haiku-based relevance filtering.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            "The search query — usually the user's question paraphrased to focus on the relevant project or implementation detail.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: FETCH_URL,
    description:
      'Fetch the text content of a public web URL the user has pasted into the chat — typically a job description, article, or external page they want discussed. Returns the page content as markdown for token efficiency. The user must have included the URL in their message; do NOT invent URLs. Use this when the user provides a URL and the answer requires reading that page. Fetched content is for THIS turn only and is not persisted. Very long pages are truncated at ~150K tokens with a notice appended.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            "The HTTP or HTTPS URL to fetch, taken verbatim from the user's message.",
        },
      },
      required: ['url'],
    },
  },
];

export type ToolCallResult = {
  formatted: string;
  metadata: {
    // The user-facing input — query string for search_*, the URL for
    // fetch_url. Stored verbatim in the trace for M3 eval surfacing.
    query: string;
    source: ToolSource;
    chunk_ids: number[];
    top_scores: number[];
    no_match: boolean;
    // fetch_url only — sourceUrl is the post-redirect URL,
    // truncated marks which size cap fired if any.
    fetch_url?: {
      source_url: string;
      truncated: 'none' | 'raw' | 'markdown';
      error: string | null;
    };
  };
};

type MatchRow = {
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: { h2_heading?: string; h3_heading?: string } | null;
  score: number;
  semantic_distance: number | null;
};

// M2.7: the cosine floor is now a cost-control PRE-FILTER, not the
// relevance signal — those duties moved to the reranker. Default
// drops from 0.3 → 0.15 (configurable via RAG_MIN_COSINE_SIMILARITY)
// because the threshold now exists only to skip obvious noise before
// paying for Haiku, not to separate borderline-relevant from
// borderline-irrelevant. The reranker handles that separation via
// binary verdicts.

// Sent to the model as tool_result when retrieval returns nothing
// above the cosine-similarity floor. The MUST NOT line is the
// fabrication guardrail — in-context tool_result instructions are more
// reliably followed than system-prompt rules during the tool-use loop.
// Per santifer's finding, this single change reduced hallucination
// rate more than any retrieval tweak.
export const NO_MATCH_TOOL_RESULT =
  "No relevant content found for this query. You MUST NOT fabricate details about Tushar's experience, projects, or background. Say you don't have that information and suggest the user ask about a different topic or reach out directly via the contact form.";

export function isToolName(name: string): name is ToolName {
  return (
    name === SEARCH_EXPERIENCE ||
    name === SEARCH_RESUME ||
    name === SEARCH_README ||
    name === FETCH_URL
  );
}

export async function executeTool(
  toolName: ToolName,
  input: unknown,
  parentSpan: ToolParentSpan = null,
): Promise<ToolCallResult> {
  if (toolName === FETCH_URL) {
    const url = (input as { url?: unknown })?.url;
    if (typeof url !== 'string' || url.length === 0) {
      return {
        formatted: 'Invalid input: fetch_url requires a `url` string.',
        metadata: {
          query: '',
          source: 'url',
          chunk_ids: [],
          top_scores: [],
          no_match: true,
          fetch_url: {
            source_url: '',
            truncated: 'none',
            error: 'missing or invalid url input',
          },
        },
      };
    }
    return executeFetchUrl(url);
  }

  const query = (input as { query?: unknown })?.query;
  if (typeof query !== 'string' || query.length === 0) {
    return {
      formatted: 'Invalid input: search tools require a `query` string.',
      metadata: {
        query: '',
        source: SEARCH_SOURCE_MAP[toolName],
        chunk_ids: [],
        top_scores: [],
        no_match: true,
      },
    };
  }
  return executeSearch(toolName, query, parentSpan);
}

async function executeFetchUrl(url: string): Promise<ToolCallResult> {
  const result = await fetchUrl(url);
  if ('error' in result) {
    console.log('[chat] fetch_url error', { url, error: result.error });
    return {
      formatted: `[fetch_url error] ${result.error}`,
      metadata: {
        query: url,
        source: 'url',
        chunk_ids: [],
        top_scores: [],
        no_match: true,
        fetch_url: {
          source_url: url,
          truncated: 'none',
          error: result.error,
        },
      },
    };
  }
  const header =
    `[Fetched: ${result.sourceUrl}]\n` +
    (result.truncated !== 'none' ? `[Truncation: ${result.truncated}]\n` : '');
  return {
    formatted: header + '\n' + result.content,
    metadata: {
      query: url,
      source: 'url',
      chunk_ids: [],
      top_scores: [],
      no_match: false,
      fetch_url: {
        source_url: result.sourceUrl,
        truncated: result.truncated,
        error: null,
      },
    },
  };
}

async function executeSearch(
  toolName: Exclude<ToolName, typeof FETCH_URL>,
  query: string,
  parentSpan: ToolParentSpan = null,
): Promise<ToolCallResult> {
  const source = SEARCH_SOURCE_MAP[toolName];

  // Child: embedding (duration + Voyage tokens). A model call, so it's a
  // generation — only generations carry usageDetails for cost rollup.
  let embeddingGen = null;
  try {
    embeddingGen =
      parentSpan?.generation({
        name: 'embedding',
        model: 'voyage-3',
        input: { query },
        startTime: new Date(),
      }) ?? null;
  } catch (err) {
    console.error('[langfuse] embedding generation create failed:', err);
  }
  const {
    vectors: [queryEmbedding],
    tokens: embedTokens,
  } = await embed([query], 'query');
  try {
    embeddingGen?.end({
      output: { dimension: queryEmbedding.length },
      usageDetails: { input: embedTokens, total: embedTokens },
    });
  } catch (err) {
    console.error('[langfuse] embedding generation end failed:', err);
  }

  const supabase = getSupabaseClient();

  // Child span: retrieval (duration only — Supabase RPC has no tokens).
  let retrievalSpan = null;
  try {
    retrievalSpan =
      parentSpan?.span({
        name: 'retrieval',
        input: { match_count: MATCH_COUNT, source },
        startTime: new Date(),
      }) ?? null;
  } catch (err) {
    console.error('[langfuse] retrieval span create failed:', err);
  }
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    query_text: query,
    match_count: MATCH_COUNT,
    source_filter: source,
  });

  if (error) {
    throw new Error(`match_chunks failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchRow[];
  try {
    retrievalSpan?.end({ output: { rows_returned: rows.length } });
  } catch (err) {
    console.error('[langfuse] retrieval span end failed:', err);
  }

  // M2.7: the reranker owns the cosine pre-filter (default 0.15)
  // AND the Haiku verdict pass that decides which chunks reach the
  // tool_result. An empty return means either everything failed
  // pre-filter (low cosine) or Haiku marked every survivor "no"
  // (out-of-corpus). Both paths trigger the no_match guardrail
  // here.
  // Child: rerank (duration + Haiku tokens). A model call, so it's a
  // generation — only generations carry usageDetails for cost rollup.
  let rerankGen = null;
  try {
    rerankGen =
      parentSpan?.generation({
        name: 'rerank',
        model: HAIKU_MODEL,
        modelParameters: {
          temperature: HAIKU_TEMPERATURE,
          max_tokens: HAIKU_MAX_TOKENS,
        },
        input: { candidates: rows.length },
        startTime: new Date(),
      }) ?? null;
  } catch (err) {
    console.error('[langfuse] rerank generation create failed:', err);
  }
  const {
    chunks: reranked,
    tokensIn: rerankTokensIn,
    tokensOut: rerankTokensOut,
  } = await rerankChunks(query, rows);
  try {
    rerankGen?.end({
      output: { survived: reranked.length },
      usageDetails: {
        input: rerankTokensIn,
        output: rerankTokensOut,
        total: rerankTokensIn + rerankTokensOut,
      },
    });
  } catch (err) {
    console.error('[langfuse] rerank generation end failed:', err);
  }

  if (reranked.length === 0) {
    console.log('[rag] no_match', { query, source });
    return {
      formatted: NO_MATCH_TOOL_RESULT,
      metadata: {
        query,
        source,
        chunk_ids: [],
        top_scores: [],
        no_match: true,
      },
    };
  }

  const formatted = reranked
    .map((row) => {
      const score = row.score.toFixed(4);
      const meta = row.metadata ?? {};
      const h2 = meta.h2_heading ?? '(no h2)';
      const h3 = meta.h3_heading ?? '(no h3)';
      return `[Source: ${source}, score: ${score}]\n${h2} > ${h3}\n${row.content}`;
    })
    .join('\n\n---\n\n');

  return {
    formatted,
    metadata: {
      query,
      source,
      chunk_ids: reranked.map((r) => r.chunk_index),
      top_scores: reranked.map((r) => r.score),
      no_match: false,
    },
  };
}
