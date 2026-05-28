// Unit tests for the constant-time Bearer-secret comparison helper.
// Covers timingSafeBearerMatch (the low-level compare) and verifyCronAuth
// (the not-configured / invalid / ok result-type wrapper that drives
// 503 vs 401 in the cron handler).

import { describe, it, expect } from 'vitest';

import { timingSafeBearerMatch, verifyCronAuth } from './_authBearer.js';

describe('timingSafeBearerMatch', () => {
  it('returns true on exact Bearer match', () => {
    expect(timingSafeBearerMatch('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('returns false on wrong secret of the same length', () => {
    expect(timingSafeBearerMatch('Bearer wr0ng!', 's3cret')).toBe(false);
  });

  it('returns false uniformly on length mismatch (timingSafeEqual would otherwise throw)', () => {
    // Header shorter than expected
    expect(timingSafeBearerMatch('Bearer a', 's3cret')).toBe(false);
    // Header longer than expected
    expect(timingSafeBearerMatch('Bearer s3cretextra', 's3cret')).toBe(false);
    // Empty header
    expect(timingSafeBearerMatch('', 's3cret')).toBe(false);
  });

  it('returns false on undefined header (no auth sent)', () => {
    expect(timingSafeBearerMatch(undefined, 's3cret')).toBe(false);
  });

  it('returns false on array-shaped header (multi-value, never legitimate for Authorization)', () => {
    expect(timingSafeBearerMatch(['Bearer s3cret'], 's3cret')).toBe(false);
  });

  it('returns false when Bearer prefix is missing or wrong scheme', () => {
    expect(timingSafeBearerMatch('Token s3cret', 's3cret')).toBe(false);
    expect(timingSafeBearerMatch('s3cret', 's3cret')).toBe(false);
  });
});

describe('verifyCronAuth', () => {
  it('returns ok:true on a correct Bearer match', () => {
    expect(verifyCronAuth('Bearer s3cret', 's3cret')).toEqual({ ok: true });
  });

  it('distinguishes not-configured (env unset/empty) from invalid', () => {
    expect(verifyCronAuth('Bearer anything', undefined)).toEqual({
      ok: false,
      reason: 'not-configured',
    });
    expect(verifyCronAuth('Bearer anything', '')).toEqual({
      ok: false,
      reason: 'not-configured',
    });
  });

  it('returns invalid on wrong secret', () => {
    expect(verifyCronAuth('Bearer wrong', 's3cret')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('returns invalid on undefined / array-shaped header (still passes the env-set guard first)', () => {
    expect(verifyCronAuth(undefined, 's3cret')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyCronAuth(['Bearer s3cret'], 's3cret')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('returns invalid on length-mismatched header without crashing', () => {
    expect(verifyCronAuth('Bearer s', 's3cret')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyCronAuth('Bearer s3cretextra', 's3cret')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
