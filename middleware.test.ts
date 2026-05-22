// Integration test for the Vercel middleware wrapper. Mocks the
// Upstash Redis client + the @vercel/functions waitUntil hook so we
// can assert that bot UAs / missing IPs are skipped without
// incrementing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  hset: vi.fn(),
  expire: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: () => ({
      hset: mocks.hset,
      expire: mocks.expire,
    }),
  },
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

// Lazy import so mocks are wired before the module reads its imports.
async function loadMiddleware() {
  const mod = await import('./middleware.js');
  return mod.default as (req: Request) => Promise<Response | undefined>;
}

function makeReq(
  ua: string | null,
  forwardedFor: string | null = '203.0.113.45',
): Request {
  const headers: Record<string, string> = {};
  if (ua !== null) headers['user-agent'] = ua;
  if (forwardedFor !== null) headers['x-forwarded-for'] = forwardedFor;
  return new Request('https://tusharjayanti.io/', { method: 'GET', headers });
}

describe('middleware (visitor counter)', () => {
  beforeEach(() => {
    mocks.hset.mockReset();
    mocks.expire.mockReset();
    mocks.waitUntil.mockReset();
    mocks.hset.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.waitUntil.mockImplementation((p: Promise<unknown>) => {
      // Force the awaitable to settle so HSET assertions fire inside
      // the test's async flow rather than after the runtime hands the
      // function instance back to the platform.
      return p as unknown as void;
    });
  });

  it('increments the visitor hash for a human UA', async () => {
    const handler = await loadMiddleware();
    await handler(makeReq('Mozilla/5.0 (Macintosh) Chrome/120'));
    // waitUntil received the promise, which we forced-resolve above.
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    const p = mocks.waitUntil.mock.calls[0]![0] as Promise<unknown>;
    await p;
    expect(mocks.hset).toHaveBeenCalledOnce();
    expect(mocks.expire).toHaveBeenCalledOnce();
    const [key, field] = mocks.hset.mock.calls[0]!;
    expect(key).toMatch(/^ops:visitors:\d{4}-\d{2}-\d{2}$/);
    // Field is { <16-hex>: 1 }
    expect(Object.keys(field as Record<string, unknown>)[0]).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it('skips bot UAs entirely (no waitUntil, no Redis call)', async () => {
    const handler = await loadMiddleware();
    await handler(makeReq('Mozilla/5.0 (compatible; Googlebot/2.1)'));
    expect(mocks.waitUntil).not.toHaveBeenCalled();
    expect(mocks.hset).not.toHaveBeenCalled();
  });

  it('skips when no IP can be extracted', async () => {
    const handler = await loadMiddleware();
    await handler(makeReq('Mozilla/5.0 (Macintosh) Chrome/120', null));
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('does not return a Response (allows normal page render)', async () => {
    const handler = await loadMiddleware();
    const result = await handler(makeReq('Mozilla/5.0 (Macintosh) Chrome/120'));
    expect(result).toBeUndefined();
  });
});
