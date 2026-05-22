// Unit tests for the visitor-counter primitives. The Vercel
// middleware wrapper at `/middleware.ts` is exercised separately
// (see middleware.test.ts).

import { describe, it, expect, vi } from 'vitest';
import {
  extractIp,
  hashIpForVisitor,
  isBotUserAgent,
  recordVisitor,
  todayUtc,
  visitorHashKey,
  type VisitorRedis,
} from './_visitorCounter.js';

describe('isBotUserAgent', () => {
  it('returns true for common bot UA substrings', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(
      true,
    );
    expect(isBotUserAgent('Slackbot-LinkExpanding 1.0')).toBe(true);
    expect(isBotUserAgent('discordbot/2.0')).toBe(true);
    expect(isBotUserAgent('SomeCustomBot/1.0')).toBe(true);
    expect(isBotUserAgent('whatsapp link preview/1.0')).toBe(true);
    expect(isBotUserAgent('crawler-something')).toBe(true);
  });

  it('returns false for human browser UAs', () => {
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605',
      ),
    ).toBe(false);
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit',
      ),
    ).toBe(false);
  });

  it('returns false for empty / null / undefined UA', () => {
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });
});

describe('hashIpForVisitor', () => {
  it('returns a stable 16-hex-char digest', async () => {
    const h1 = await hashIpForVisitor('203.0.113.45');
    const h2 = await hashIpForVisitor('203.0.113.45');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns different digests for different IPs', async () => {
    const h1 = await hashIpForVisitor('203.0.113.45');
    const h2 = await hashIpForVisitor('203.0.113.46');
    expect(h1).not.toBe(h2);
  });
});

describe('extractIp', () => {
  it('reads the first IP from x-forwarded-for', () => {
    const h = new Headers({
      'x-forwarded-for': '203.0.113.45, 10.0.0.1, 172.16.0.2',
    });
    expect(extractIp(h)).toBe('203.0.113.45');
  });

  it('falls back to x-real-ip', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.7' });
    expect(extractIp(h)).toBe('198.51.100.7');
  });

  it('returns null when no IP headers are present', () => {
    expect(extractIp(new Headers())).toBeNull();
  });
});

describe('recordVisitor', () => {
  it('HSETs the field with value 1 and EXPIREs the key', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const fake: VisitorRedis = {
      hset: async (key, field) => {
        calls.push({ op: 'hset', args: [key, field] });
        return 1;
      },
      expire: async (key, seconds) => {
        calls.push({ op: 'expire', args: [key, seconds] });
        return 1;
      },
    };

    const day = '2026-05-22';
    await recordVisitor(fake, 'abcdef1234567890', day);
    expect(calls).toEqual([
      {
        op: 'hset',
        args: ['ops:visitors:2026-05-22', { abcdef1234567890: 1 }],
      },
      { op: 'expire', args: ['ops:visitors:2026-05-22', 60 * 60 * 24 * 8] },
    ]);
  });

  it('uses todayUtc when day omitted', async () => {
    const captured = vi.fn<VisitorRedis['hset']>(async () => 1);
    const fake: VisitorRedis = {
      hset: captured,
      expire: async () => 1,
    };
    await recordVisitor(fake, 'deadbeefdeadbeef');
    expect(captured).toHaveBeenCalledOnce();
    const expectedKey = visitorHashKey(todayUtc());
    expect(captured).toHaveBeenCalledWith(expectedKey, expect.any(Object));
  });
});
