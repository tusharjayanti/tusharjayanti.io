import { describe, it, expect } from 'vitest';

import {
  questionText,
  answerText,
  toListItem,
  paginateList,
  buildSpans,
  langfuseUrl,
  buildDetail,
} from './_opsConversations.js';
import type { OpsRawTrace, OpsObservation } from './_opsQuery.js';

function rawTrace(over: Partial<OpsRawTrace> = {}): OpsRawTrace {
  return {
    id: 't1',
    name: 'chat-turn',
    timestamp: '2026-05-22T08:00:00Z',
    tags: [],
    totalCost: 0.012,
    latency: 1.8,
    metadata: {},
    input: { q: 'what did Tushar build at scale?' },
    output: 'He ran payments infra at 10k TPS.',
    htmlPath: '/project/p1/traces/t1',
    projectId: 'p1',
    scores: [],
    ...over,
  };
}

function obs(over: Partial<OpsObservation>): OpsObservation {
  return {
    id: 'o',
    traceId: 't1',
    name: 'anthropic_first_call',
    model: 'claude-sonnet-4-6',
    calculatedTotalCost: 0.01,
    latency: 1.5,
    startTime: '2026-05-22T08:00:00.000Z',
    ...over,
  };
}

describe('text extraction', () => {
  it('pulls the question from {q} or a bare string', () => {
    expect(questionText({ q: 'hi' })).toBe('hi');
    expect(questionText('hi')).toBe('hi');
    expect(questionText(null)).toBe('');
  });
  it('pulls the answer from a string or common text keys', () => {
    expect(answerText('plain')).toBe('plain');
    expect(answerText({ text: 'x' })).toBe('x');
    expect(answerText({ answer: 'y' })).toBe('y');
    expect(answerText({ nope: 1 })).toBe('');
  });
});

describe('toListItem', () => {
  it('maps a raw trace to a list item with derived flags', () => {
    const item = toListItem(
      rawTrace({ tags: ['grounded', 'model-refused'], latency: 2.0 }),
    );
    expect(item).toMatchObject({
      id: 't1',
      latency_ms: 2000,
      cost_usd: 0.012,
      grounded: true,
      refused: true,
    });
    expect(item.preview_q).toContain('Tushar');
    expect(item.preview_a).toContain('payments');
  });
});

describe('paginateList', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}` }));
  it('slices page 1 and reports hasMore', () => {
    const p = paginateList(items, 1, 20);
    expect(p.items).toHaveLength(20);
    expect(p.total).toBe(25);
    expect(p.hasMore).toBe(true);
  });
  it('slices the final page and clears hasMore', () => {
    const p = paginateList(items, 2, 20);
    expect(p.items).toHaveLength(5);
    expect(p.hasMore).toBe(false);
    // page-2 ids continue where page-1 left off (merge-friendly)
    expect(p.items[0].id).toBe('t20');
  });
  it('clamps page to >= 1', () => {
    expect(paginateList(items, 0, 20).page).toBe(1);
  });
});

describe('buildSpans', () => {
  it('positions spans relative to the earliest start, sorted', () => {
    const spans = buildSpans([
      obs({
        name: 'rerank',
        startTime: '2026-05-22T08:00:02.000Z',
        latency: 0.2,
      }),
      obs({
        name: 'anthropic_first_call',
        startTime: '2026-05-22T08:00:00.000Z',
        latency: 1.5,
      }),
    ]);
    expect(spans.map((s) => s.name)).toEqual([
      'anthropic_first_call',
      'rerank',
    ]);
    expect(spans[0].offset_ms).toBe(0);
    expect(spans[0].duration_ms).toBe(1500);
    expect(spans[1].offset_ms).toBe(2000);
  });
  it('returns [] when no observation has a start time', () => {
    expect(buildSpans([obs({ startTime: '' })])).toEqual([]);
  });
});

describe('langfuseUrl', () => {
  it('prefers htmlPath, falls back to projectId, else null', () => {
    expect(langfuseUrl(rawTrace(), 'https://lf.test/')).toBe(
      'https://lf.test/project/p1/traces/t1',
    );
    expect(langfuseUrl(rawTrace({ htmlPath: null }), 'https://lf.test')).toBe(
      'https://lf.test/project/p1/traces/t1',
    );
    expect(
      langfuseUrl(
        rawTrace({ htmlPath: null, projectId: null }),
        'https://lf.test',
      ),
    ).toBeNull();
  });
});

describe('buildDetail', () => {
  it('shapes a full detail incl. rag metadata + spans + link', () => {
    const detail = buildDetail(
      rawTrace({
        tags: ['grounded'],
        metadata: {
          rag_retrieved: true,
          rag_no_match: false,
          rag_sources: ['experience'],
        },
      }),
      [obs({})],
      [{ name: 'quality', value: 1 }],
      'https://lf.test',
    );
    expect(detail.question).toContain('Tushar');
    expect(detail.rag).toEqual({
      retrieved: true,
      no_match: false,
      sources: ['experience'],
    });
    expect(detail.spans).toHaveLength(1);
    expect(detail.scores).toHaveLength(1);
    expect(detail.langfuse_url).toBe('https://lf.test/project/p1/traces/t1');
  });
});
