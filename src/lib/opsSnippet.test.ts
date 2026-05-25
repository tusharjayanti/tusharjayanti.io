// Tests for the formatting helpers backing the OpsSnippet React
// component. Component rendering itself is verified manually via dev
// server (no JSDOM in this repo).

import { describe, it, expect } from 'vitest';
import {
  buildOpsView,
  formatCount,
  formatRatio,
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

describe('formatRatio', () => {
  it('always shows one decimal place', () => {
    expect(formatRatio(2.1)).toBe('2.1');
    expect(formatRatio(2)).toBe('2.0');
    expect(formatRatio(0)).toBe('0.0');
    // 0.25 → 0.3 is a cleaner rounding case than 0.15 (which IEEE-754
    // represents as 0.149999..., yielding "0.1" via toFixed).
    expect(formatRatio(0.25)).toBe('0.3');
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
  it('renders live data with formatted rows', () => {
    const view = buildOpsView({
      visitors: 247,
      queries: 89,
      tokens: 1_234_567,
      tools_per_turn: 2.1,
      last_aggregated_at: '2026-05-22T14:32:00Z',
      is_offline: false,
    });
    expect(view.is_offline).toBe(false);
    expect(view.rows).toEqual([
      { label: 'visitors', value: '247' },
      { label: 'queries', value: '89' },
      { label: 'tokens', value: '1.2M' },
      { label: 'tools/turn', value: '2.1' },
    ]);
    expect(view.footer).toBe('14:32 UTC');
    expect(view.mobile).toBe('247 vis · 89 q · 1.2M tok · 2.1 t/t');
  });

  it('renders offline state for null', () => {
    const view = buildOpsView(null);
    expect(view.is_offline).toBe(true);
    expect(view.rows.every((r) => r.value === '--')).toBe(true);
    expect(view.footer).toBe('offline');
    expect(view.mobile).toBe('offline');
  });

  it('renders offline state for is_offline: true blob', () => {
    const view = buildOpsView({
      visitors: null,
      queries: null,
      tokens: null,
      tools_per_turn: null,
      last_aggregated_at: null,
      is_offline: true,
    });
    expect(view.is_offline).toBe(true);
    expect(view.footer).toBe('offline');
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
        tools_per_turn: null,
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
        tools_per_turn: 0,
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
        tools_per_turn: 1.5,
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
        tools_per_turn: 0,
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
        tools_per_turn: 2.1,
        last_aggregated_at: '2026-05-25T14:32:00Z',
        is_offline: false,
      }),
    ).toBe(true);
  });
});
