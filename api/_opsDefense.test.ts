import { describe, it, expect } from 'vitest';

import {
  defenseFunnel,
  defenseTagCounts,
  recentDefenseEvents,
  defenseStats,
} from './_opsDefense.js';
import type { OpsRawTrace } from './_opsQuery.js';

function t(
  id: string,
  tags: string[],
  over: Partial<OpsRawTrace> = {},
): OpsRawTrace {
  return {
    id,
    name: 'chat-turn',
    timestamp: '2026-05-22T08:00:00Z',
    tags,
    totalCost: 0.01,
    latency: 1.5,
    metadata: {},
    input: { q: `q-${id}` },
    output: null,
    htmlPath: null,
    projectId: null,
    scores: [],
    ...over,
  };
}

describe('defenseFunnel', () => {
  // 10 total: 1 rate-limited, 2 injection, 1 streamed-error,
  // 1 trace with BOTH canary-leak AND model-refused, 1 model-refused.
  const traces = [
    t('rl', ['rate-limited']),
    t('inj1', ['injection-detected']),
    t('inj2', ['injection-detected']),
    t('err', ['streamed-error']),
    t('leakrefuse', ['canary-leak', 'model-refused']),
    t('refuse', ['model-refused']),
    t('ok1', ['grounded']),
    t('ok2', []),
    t('ok3', ['grounded']),
    t('ok4', []),
  ];

  it('counts each cumulative stage exactly (overlaps handled)', () => {
    const f = defenseFunnel(traces);
    const by = Object.fromEntries(f.map((s) => [s.stage, s.count]));
    expect(by['requests']).toBe(10);
    expect(by['passed rate-limit']).toBe(9); // -1 rl
    expect(by['passed injection screen']).toBe(7); // -2 inj
    expect(by['completed stream']).toBe(6); // -1 err
    expect(by['canary clean']).toBe(5); // -1 leak (leakrefuse)
    // -1 more for the standalone refuse; leakrefuse already excluded at
    // canary stage, so it isn't double-counted.
    expect(by['answered']).toBe(4);
  });

  it('is monotonically non-increasing', () => {
    const counts = defenseFunnel(traces).map((s) => s.count);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

describe('defenseTagCounts', () => {
  it('counts each defense tag', () => {
    const counts = defenseTagCounts([
      t('a', ['injection-detected']),
      t('b', ['injection-detected', 'streamed-error']),
      t('c', ['model-refused']),
    ]);
    expect(counts['injection-detected']).toBe(2);
    expect(counts['streamed-error']).toBe(1);
    expect(counts['model-refused']).toBe(1);
    expect(counts['rate-limited']).toBe(0);
    expect(counts['canary-leak']).toBe(0);
  });
});

describe('recentDefenseEvents', () => {
  it('returns injection + canary events newest-first with previews', () => {
    const events = recentDefenseEvents([
      t('old', ['injection-detected'], { timestamp: '2026-05-20T00:00:00Z' }),
      t('new', ['canary-leak'], { timestamp: '2026-05-22T00:00:00Z' }),
      t('clean', ['grounded'], { timestamp: '2026-05-23T00:00:00Z' }),
    ]);
    expect(events).toHaveLength(2); // 'clean' excluded
    expect(events[0]).toMatchObject({ id: 'new', kind: 'canary-leak' });
    expect(events[1]).toMatchObject({ id: 'old', kind: 'injection' });
    expect(events[0].preview_q).toBe('q-new');
  });
});

describe('defenseStats', () => {
  it('assembles funnel + tag_counts + recent_events', () => {
    const out = defenseStats([t('a', ['injection-detected'])]);
    expect(out.funnel[0].count).toBe(1);
    expect(out.tag_counts['injection-detected']).toBe(1);
    expect(out.recent_events).toHaveLength(1);
  });
});
