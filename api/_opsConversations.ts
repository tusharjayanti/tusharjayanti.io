// Pure shaping for the Conversations tab: trace → list item, in-memory
// pagination, and trace → master/detail (incl. the span waterfall + the
// Langfuse deep-link). Network fetch + Redis live in api/ops/traces.ts and
// api/ops/trace/[id].ts; this module is fixture-tested.

import type { OpsRawTrace, OpsObservation } from './_opsQuery.js';

const PREVIEW_Q = 140;
const PREVIEW_A = 200;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The chat handler sends `{ q: string }` as trace input; tolerate a bare
// string too.
export function questionText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'q' in input) {
    return String((input as { q: unknown }).q ?? '');
  }
  return '';
}

// Output is the assistant text (string) or an object with a common text key.
export function answerText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const k of ['text', 'answer', 'content', 'response']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return '';
}

export interface ConversationListItem {
  id: string;
  ts: string;
  latency_ms: number;
  cost_usd: number;
  tags: string[];
  grounded: boolean;
  refused: boolean;
  preview_q: string;
  preview_a: string;
}

export function toListItem(t: OpsRawTrace): ConversationListItem {
  return {
    id: t.id,
    ts: t.timestamp,
    latency_ms: Math.round(t.latency * 1000),
    cost_usd: t.totalCost,
    tags: t.tags,
    grounded: t.tags.includes('grounded'),
    refused: t.tags.includes('model-refused'),
    preview_q: truncate(questionText(t.input), PREVIEW_Q),
    preview_a: truncate(answerText(t.output), PREVIEW_A),
  };
}

export interface PaginatedList<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

// Slice an already-filtered, newest-first list. 1-based page.
export function paginateList<T>(
  items: T[],
  page: number,
  limit: number,
): PaginatedList<T> {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * limit;
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    page: safePage,
    limit,
    total: items.length,
    hasMore: start + limit < items.length,
  };
}

export interface TraceSpan {
  name: string;
  model: string;
  offset_ms: number;
  duration_ms: number;
  cost_usd: number;
}

// Waterfall spans positioned relative to the earliest observation start.
export function buildSpans(observations: OpsObservation[]): TraceSpan[] {
  const valid = observations.filter((o) => o.startTime);
  if (valid.length === 0) return [];
  const min = Math.min(...valid.map((o) => Date.parse(o.startTime)));
  return valid
    .map((o) => ({
      name: o.name,
      model: o.model,
      offset_ms: Date.parse(o.startTime) - min,
      duration_ms: Math.round(o.latency * 1000),
      cost_usd: o.calculatedTotalCost,
    }))
    .sort((a, b) => a.offset_ms - b.offset_ms);
}

// Build the Langfuse UI deep-link. Prefer the server-provided htmlPath;
// fall back to projectId + id.
export function langfuseUrl(t: OpsRawTrace, host: string): string | null {
  const base = host.replace(/\/+$/, '');
  if (t.htmlPath) return `${base}${t.htmlPath}`;
  if (t.projectId) return `${base}/project/${t.projectId}/traces/${t.id}`;
  return null;
}

export interface ConversationDetail {
  id: string;
  ts: string;
  latency_ms: number;
  cost_usd: number;
  tags: string[];
  question: string;
  answer: string;
  spans: TraceSpan[];
  scores: unknown[];
  rag: {
    retrieved: boolean;
    no_match: boolean;
    sources: unknown[];
  };
  langfuse_url: string | null;
}

export function buildDetail(
  trace: OpsRawTrace,
  observations: OpsObservation[],
  scores: unknown[],
  host: string,
): ConversationDetail {
  const md = trace.metadata ?? {};
  return {
    id: trace.id,
    ts: trace.timestamp,
    latency_ms: Math.round(trace.latency * 1000),
    cost_usd: trace.totalCost,
    tags: trace.tags,
    question: questionText(trace.input),
    answer: answerText(trace.output),
    spans: buildSpans(observations),
    scores,
    rag: {
      retrieved: md.rag_retrieved === true,
      no_match: md.rag_no_match === true,
      sources: Array.isArray(md.rag_sources) ? md.rag_sources : [],
    },
    langfuse_url: langfuseUrl(trace, host),
  };
}
