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

import { embed } from './_voyage.js';
import { getSupabaseClient } from './_supabase.js';
import { fetchUrl } from './_webFetch.js';

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
export type ToolSource = RetrievalSource | 'web';

const SEARCH_SOURCE_MAP: Record<
  Exclude<ToolName, typeof FETCH_URL>,
  RetrievalSource
> = {
  [SEARCH_EXPERIENCE]: 'experience',
  [SEARCH_RESUME]: 'resume',
  [SEARCH_README]: 'readme',
};

const MATCH_COUNT = 3;

export const TOOLS = [
  {
    name: SEARCH_EXPERIENCE,
    description:
      "Search Tushar Jayanti's experience writeups for detailed technical stories about his work at DISCO (identity platform migration, p99 latency reduction, gRPC migration), PurpleToko (0-to-1 e-commerce backend), Transcend Street Solutions (financial systems, Reserve Release feature), and Baanyan/USAA (Kafka event-driven services). Use this tool when the user asks about specific roles, technical decisions, architectural choices, or detailed engineering work. Returns the top 3 most relevant chunks.",
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
      "Search Tushar Jayanti's resume for compact summaries of his roles, skills, education, and projects. Use this tool when the user asks about high-level qualifications, what technologies he knows, his education, or current projects. The resume contains the elevator-pitch versions of his work; use search_experience for deeper technical stories. Returns the top 3 most relevant chunks.",
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
      "Search Tushar Jayanti's GitHub project READMEs for deep architecture and implementation details on his side projects (vox-agent, shortlist, tusharjayanti.io, calculator-agent, TensorflowChatbot, OpticalCharacterRecognition). Use this tool when the user asks how a specific project works internally, what its design decisions were, or for technical depth beyond what the resume covers. Returns the top 3 most relevant chunks.",
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
      "Fetch the text content of a public web URL the user has pasted into the chat — typically a job description, article, or external page they want discussed. Returns the page content as markdown for token efficiency. The user must have included the URL in their message; do NOT invent URLs. Use this when the user provides a URL and the answer requires reading that page. Fetched content is for THIS turn only and is not persisted. Very long pages are truncated at ~150K tokens with a notice appended.",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'The HTTP or HTTPS URL to fetch, taken verbatim from the user\'s message.',
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
  chunk_index: number;
  content: string;
  metadata: { h2_heading?: string; h3_heading?: string } | null;
  score: number;
  semantic_distance: number | null;
};

// Cosine-similarity floor. Threshold is on `1 - semantic_distance`
// (range 0–1), NOT on the RRF blended score (which saturates at ~0.033
// with k=60 and would be unusable as a 0.3 threshold). The RRF score
// still determines RANKING among surviving chunks; cosine is just the
// quality floor. Filtering on cosine only — a chunk with weak semantic
// match but strong BM25 hit is usually term-overlap without topic
// relevance, which we'd rather treat as noise than surface.
const DEFAULT_MIN_COSINE_SIMILARITY = 0.3;

function getMinCosineSimilarity(): number {
  const raw = process.env.RAG_MIN_COSINE_SIMILARITY;
  if (raw === undefined) return DEFAULT_MIN_COSINE_SIMILARITY;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return DEFAULT_MIN_COSINE_SIMILARITY;
  return parsed;
}

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
): Promise<ToolCallResult> {
  if (toolName === FETCH_URL) {
    const url = (input as { url?: unknown })?.url;
    if (typeof url !== 'string' || url.length === 0) {
      return {
        formatted: 'Invalid input: fetch_url requires a `url` string.',
        metadata: {
          query: '',
          source: 'web',
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
  return executeSearch(toolName, query);
}

async function executeFetchUrl(url: string): Promise<ToolCallResult> {
  const result = await fetchUrl(url);
  if ('error' in result) {
    console.log('[chat] fetch_url error', { url, error: result.error });
    return {
      formatted: `[fetch_url error] ${result.error}`,
      metadata: {
        query: url,
        source: 'web',
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
    (result.truncated !== 'none'
      ? `[Truncation: ${result.truncated}]\n`
      : '');
  return {
    formatted: header + '\n' + result.content,
    metadata: {
      query: url,
      source: 'web',
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
): Promise<ToolCallResult> {
  const source = SEARCH_SOURCE_MAP[toolName];

  const [queryEmbedding] = await embed([query], 'query');
  const supabase = getSupabaseClient();
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
  const threshold = getMinCosineSimilarity();
  // Keep only chunks where the semantic-similarity floor passes.
  // Chunks with null semantic_distance (BM25-only hits, see
  // 0004_match_chunks_hybrid.sql) are dropped — no semantic anchor
  // means they're likely term-overlap noise.
  const filtered = rows.filter((r) => {
    if (r.semantic_distance === null) return false;
    return 1 - r.semantic_distance >= threshold;
  });

  if (filtered.length === 0) {
    console.log('[rag] no_match', { query, source, threshold });
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

  const formatted = filtered
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
      chunk_ids: filtered.map((r) => r.chunk_index),
      top_scores: filtered.map((r) => r.score),
      no_match: false,
    },
  };
}
