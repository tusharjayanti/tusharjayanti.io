// Tests for the formatting helpers backing the OpsSnippet React
// component. Component rendering itself is verified manually via dev
// server (no JSDOM in this repo).

import { describe, it, expect } from 'vitest';
import {
  buildOpsView,
  formatCount,
  formatPercent,
  formatUsd,
  formatUtcTime,
  isPopulated,
} from './opsSnippet.js';

describe('formatCount', () => {
  it('renders raw integer below 1000', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(247)).toBe('247');
    expect(formatCount(999)).toBe('999');
  });

  it('renders K for thousands with one decimal', () => {
    expect(formatCount(1247)).toBe('1.2K');
    expect(formatCount(89000)).toBe('89.0K');
    expect(formatCount(999_999)).toBe('1000.0K');
  });

  it('renders M for millions with one decimal', () => {
    expect(formatCount(1_247_000)).toBe('1.2M');
    expect(formatCount(12_500_000)).toBe('12.5M');
  });

  it('defends against negatives and non-finite', () => {
    expect(formatCount(-1)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('renders integer percent', () => {
    expect(formatPercent(62)).toBe('62%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(100)).toBe('100%');
  });

  it('defends against negatives and non-finite', () => {
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('formatUsd', () => {
  it('always shows two decimals with a leading $', () => {
    expect(formatUsd(3.47)).toBe('$3.47');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(3.4)).toBe('$3.40'); // always two decimals
  });

  it('defends against negatives and non-finite', () => {
    expect(formatUsd(-1)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('formatUtcTime', () => {
  it('formats HH:MM UTC from ISO', () => {
    expect(formatUtcTime('2026-05-22T14:32:18.456Z')).toBe('14:32 UTC');
    expect(formatUtcTime('2026-05-22T03:07:00Z')).toBe('03:07 UTC');
  });

  it('returns --:-- on invalid ISO', () => {
    expect(formatUtcTime('not-a-date')).toBe('--:--');
  });
});

describe('buildOpsView', () => {
  it('renders live data with five formatted rows', () => {
    const view = buildOpsView({
      visitors: 247,
      queries: 89,
      tokens: 1_234_567,
      grounded_percent: 62,
      cost_usd: 3.47,
      last_aggregated_at: '2026-05-22T14:32:00Z',
      is_offline: false,
    });
    expect(view.is_offline).toBe(false);
    expect(view.rows).toEqual([
      { label: 'visitors', value: '247' },
      { label: 'queries', value: '89' },
      { label: 'tokens', value: '1.2M' },
      { label: 'queries_grounded', value: '62%' },
      { label: 'cost', value: '$3.47' },
    ]);
    expect(view.footer).toBe('last 7d · 14:32 UTC');
    expect(view.mobile).toBe(
      'last 7d · visitors:247 · queries:89 · tokens:1.2M · grounded:62% · cost:$3.47',
    );
  });

  it('renders offline state for null', () => {
    const view = buildOpsView(null);
    expect(view.is_offline).toBe(true);
    expect(view.rows).toHaveLength(5);
    expect(view.rows.every((r) => r.value === '--')).toBe(true);
    expect(view.footer).toBe('offline');
    expect(view.mobile).toBe('offline');
  });

  it('renders offline state for is_offline: true blob', () => {
    const view = buildOpsView({
      visitors: null,
      queries: null,
      tokens: null,
      grounded_percent: null,
      cost_usd: null,
      last_aggregated_at: null,
      is_offline: true,
    });
    expect(view.is_offline).toBe(true);
    expect(view.rows).toHaveLength(5);
    expect(view.footer).toBe('offline');
  });

  it('mobile key:value format — zero state', () => {
    const view = buildOpsView({
      visitors: 0,
      queries: 0,
      tokens: 0,
      grounded_percent: 0,
      cost_usd: 0,
      last_aggregated_at: '2026-05-26T00:00:00Z',
      is_offline: false,
    });
    expect(view.mobile).toBe(
      'last 7d · visitors:0 · queries:0 · tokens:0 · grounded:0% · cost:$0.00',
    );
  });

  it('mobile key:value format — high values (raw visitors/queries, abbreviated tokens)', () => {
    const view = buildOpsView({
      visitors: 1200,
      queries: 999,
      tokens: 2_400_000,
      grounded_percent: 88,
      cost_usd: 12.5,
      last_aggregated_at: '2026-05-26T00:00:00Z',
      is_offline: false,
    });
    expect(view.mobile).toBe(
      'last 7d · visitors:1200 · queries:999 · tokens:2.4M · grounded:88% · cost:$12.50',
    );
  });
});

describe('isPopulated', () => {
  it('returns false for null (fetch failed / pending)', () => {
    expect(isPopulated(null)).toBe(false);
  });

  it('returns false for the offline sentinel', () => {
    expect(
      isPopulated({
        visitors: null,
        queries: null,
        tokens: null,
        grounded_percent: null,
        cost_usd: null,
        last_aggregated_at: null,
        is_offline: true,
      }),
    ).toBe(false);
  });

  it('returns false when every metric is zero (cold start)', () => {
    expect(
      isPopulated({
        visitors: 0,
        queries: 0,
        tokens: 0,
        grounded_percent: 0,
        cost_usd: 0,
        last_aggregated_at: '2026-05-25T00:00:00Z',
        is_offline: false,
      }),
    ).toBe(false);
  });

  it('returns false when last_aggregated_at is missing', () => {
    expect(
      isPopulated({
        visitors: 10,
        queries: 5,
        tokens: 1234,
        grounded_percent: 40,
        cost_usd: 0.12,
        // Cast: realistic shape produced by a partial/malformed backend
        // response — the type guard should fail closed.
        last_aggregated_at: null as unknown as string,
        is_offline: false,
      }),
    ).toBe(false);
  });

  it('returns true when at least one metric is non-zero', () => {
    expect(
      isPopulated({
        visitors: 1,
        queries: 0,
        tokens: 0,
        grounded_percent: 0,
        cost_usd: 0,
        last_aggregated_at: '2026-05-25T00:00:00Z',
        is_offline: false,
      }),
    ).toBe(true);
  });

  it('returns true for a fully populated snippet', () => {
    expect(
      isPopulated({
        visitors: 247,
        queries: 89,
        tokens: 1_234_567,
        grounded_percent: 62,
        cost_usd: 3.47,
        last_aggregated_at: '2026-05-25T14:32:00Z',
        is_offline: false,
      }),
    ).toBe(true);
  });
});
