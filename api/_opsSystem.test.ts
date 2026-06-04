import { describe, it, expect } from 'vitest';

import { headroomBar, summarizeRateLimits } from './_opsSystem.js';

describe('headroomBar', () => {
  it('computes a one-decimal percentage', () => {
    const b = headroomBar('k', 'L', 12_500, 50_000, '50k/mo');
    expect(b.pct).toBe(25);
    expect(b).toMatchObject({ key: 'k', used: 12_500, cap: 50_000 });
  });
  it('clamps over-cap usage to 100', () => {
    expect(headroomBar('k', 'L', 60_000, 50_000, 'c').pct).toBe(100);
  });
  it('returns 0 pct for a zero/invalid cap (no divide-by-zero)', () => {
    expect(headroomBar('k', 'L', 5, 0, 'c').pct).toBe(0);
  });
});

describe('summarizeRateLimits', () => {
  it('sums requests, counts IPs, and flags those at the cap', () => {
    const s = summarizeRateLimits([3, 40, 41, 1], 40, '2026-06-03T09');
    expect(s).toEqual({
      window: '2026-06-03T09',
      requests: 85,
      distinct_ips: 4,
      at_cap: 2, // 40 and 41 both >= 40
      per_ip_cap: 40,
    });
  });
  it('handles an empty window', () => {
    expect(summarizeRateLimits([], 40, 'w')).toMatchObject({
      requests: 0,
      distinct_ips: 0,
      at_cap: 0,
    });
  });
});
