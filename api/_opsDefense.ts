// Pure defense aggregation for the Defense tab: a cumulative guardrail
// funnel + per-tag counts + recent security events. Operates on the
// window's traces WITHOUT the realUser filter — the whole point is to see
// the rate-limited / injection-detected short-circuits realUser drops.

import type { OpsRawTrace } from './_opsQuery.js';
import { questionText } from './_opsConversations.js';

// Security/defense tags, in funnel order. rate-limited & injection-detected
// short-circuit before the model; streamed-error / canary-leak /
// model-refused are post-generation.
export const DEFENSE_TAG_LIST = [
  'rate-limited',
  'injection-detected',
  'streamed-error',
  'canary-leak',
  'model-refused',
] as const;

export interface FunnelStage {
  stage: string;
  count: number;
}

// Cumulative funnel: each stage counts traces that cleared it AND every
// prior stage. Using a cumulative predicate (rather than sequential
// subtraction) is exact even when post-generation tags co-occur on one
// trace (e.g. canary-leak + model-refused).
export function defenseFunnel(traces: OpsRawTrace[]): FunnelStage[] {
  const gates: Array<[string, (t: OpsRawTrace) => boolean]> = [
    ['requests', () => true],
    ['passed rate-limit', (t) => !t.tags.includes('rate-limited')],
    ['passed injection screen', (t) => !t.tags.includes('injection-detected')],
    ['completed stream', (t) => !t.tags.includes('streamed-error')],
    ['canary clean', (t) => !t.tags.includes('canary-leak')],
    ['answered', (t) => !t.tags.includes('model-refused')],
  ];
  return gates.map((_, i) => {
    const active = gates.slice(0, i + 1).map(([, fn]) => fn);
    const count = traces.filter((t) => active.every((fn) => fn(t))).length;
    return { stage: gates[i][0], count };
  });
}

export function defenseTagCounts(
  traces: OpsRawTrace[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tag of DEFENSE_TAG_LIST) {
    out[tag] = traces.filter((t) => t.tags.includes(tag)).length;
  }
  return out;
}

export interface DefenseEvent {
  id: string;
  ts: string;
  kind: 'injection' | 'canary-leak';
  preview_q: string;
}

const KIND_BY_TAG: Record<string, DefenseEvent['kind']> = {
  'injection-detected': 'injection',
  'canary-leak': 'canary-leak',
};

// Most-recent injection / canary-leak events, newest first, capped.
export function recentDefenseEvents(
  traces: OpsRawTrace[],
  limit = 20,
): DefenseEvent[] {
  const events: DefenseEvent[] = [];
  for (const t of traces) {
    for (const tag of ['injection-detected', 'canary-leak'] as const) {
      if (t.tags.includes(tag)) {
        events.push({
          id: t.id,
          ts: t.timestamp,
          kind: KIND_BY_TAG[tag],
          preview_q: questionText(t.input)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140),
        });
      }
    }
  }
  return events.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

export interface DefenseData {
  funnel: FunnelStage[];
  tag_counts: Record<string, number>;
  recent_events: DefenseEvent[];
}

export function defenseStats(traces: OpsRawTrace[]): DefenseData {
  return {
    funnel: defenseFunnel(traces),
    tag_counts: defenseTagCounts(traces),
    recent_events: recentDefenseEvents(traces),
  };
}
