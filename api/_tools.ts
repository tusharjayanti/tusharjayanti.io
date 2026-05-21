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

export const SEARCH_EXPERIENCE = 'search_experience';
export const SEARCH_RESUME = 'search_resume';
export const SEARCH_README = 'search_readme';

export type ToolName =
  | typeof SEARCH_EXPERIENCE
  | typeof SEARCH_RESUME
  | typeof SEARCH_README;
type RetrievalSource = 'experience' | 'resume' | 'readme';

const TOOL_SOURCE_MAP: Record<ToolName, RetrievalSource> = {
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
];

export type ToolCallResult = {
  formatted: string;
  metadata: {
    query: string;
    source: RetrievalSource;
    chunk_ids: number[];
    top_scores: number[];
  };
};

type MatchRow = {
  chunk_index: number;
  content: string;
  metadata: { h2_heading?: string; h3_heading?: string } | null;
  score: number;
};

export function isToolName(name: string): name is ToolName {
  return (
    name === SEARCH_EXPERIENCE ||
    name === SEARCH_RESUME ||
    name === SEARCH_README
  );
}

export async function executeTool(
  toolName: ToolName,
  query: string,
): Promise<ToolCallResult> {
  const source = TOOL_SOURCE_MAP[toolName];

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
  if (rows.length === 0) {
    return {
      formatted: '[No relevant results found in this source.]',
      metadata: { query, source, chunk_ids: [], top_scores: [] },
    };
  }

  const formatted = rows
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
      chunk_ids: rows.map((r) => r.chunk_index),
      top_scores: rows.map((r) => r.score),
    },
  };
}
