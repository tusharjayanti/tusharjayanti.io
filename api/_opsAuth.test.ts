// Unit tests for the /ops single-user signed-session auth. Pure-crypto
// tests need no mocks; the endpoint-cycle + rate-limit tests mock Upstash
// at the boundary (same vi.hoisted pattern as _kv.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeRedis = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: () => fakeRedis },
}));

const {
  signSession,
  verifySession,
  verifyOpsPassword,
  issueSession,
  issueCookie,
  clearCookie,
  readSessionCookie,
  requireSession,
  SESSION_TTL_SECONDS,
} = await import('./_opsAuth.js');
// Handlers now live in the consolidated dispatcher's handler module
// (the per-route files were collapsed behind api/ops/[...path].ts).
const { handleLogin, handleMe, handleLogout } =
  await import('./_opsRouteHandlers.js');
const loginHandler = handleLogin;
const meHandler = handleMe;
const logoutHandler = handleLogout;

const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'test-hmac-key';

const originalEnv = {
  OPS_PASSWORD: process.env.OPS_PASSWORD,
  OPS_SESSION_SECRET: process.env.OPS_SESSION_SECRET,
};

beforeEach(() => {
  process.env.OPS_PASSWORD = PASSWORD;
  process.env.OPS_SESSION_SECRET = SECRET;
  fakeRedis.incr.mockReset().mockResolvedValue(1); // first attempt: under limit
  fakeRedis.expire.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  process.env.OPS_PASSWORD = originalEnv.OPS_PASSWORD;
  process.env.OPS_SESSION_SECRET = originalEnv.OPS_SESSION_SECRET;
});

// ---- fake req / res ----

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: unknown): FakeRes;
  setHeader(k: string, v: string): void;
}

function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    send(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
  };
  return res;
}

function makeReq(opts: {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return { method: opts.method, headers: opts.headers ?? {}, body: opts.body };
}

// Pull the ops_session token out of a Set-Cookie header value.
function tokenFromSetCookie(setCookie: string): string {
  const m = /ops_session=([^;]*)/.exec(setCookie);
  return m ? m[1] : '';
}

describe('signSession / verifySession', () => {
  it('round-trips a valid token', () => {
    const now = 1_000_000;
    const token = signSession({ exp: now + 100 });
    expect(verifySession(token, now)).toEqual({ exp: now + 100 });
  });

  it('rejects a tampered signature (constant-time compare path)', () => {
    const now = 1_000_000;
    const token = signSession({ exp: now + 100 });
    const [payload, sig] = token.split('.');
    // Flip the last sig char — same length, different content.
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifySession(`${payload}.${flipped}`, now)).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const now = 1_000_000;
    const token = signSession({ exp: now + 100 });
    const sig = token.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ exp: now + 999999 })).toString(
      'base64url',
    );
    expect(verifySession(`${forged}.${sig}`, now)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = 1_000_000;
    const token = signSession({ exp: now - 1 });
    expect(verifySession(token, now)).toBeNull();
  });

  it('rejects malformed / missing tokens', () => {
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession('')).toBeNull();
    expect(verifySession('nodot')).toBeNull();
    expect(verifySession('.onlysig')).toBeNull();
    expect(verifySession('onlypayload.')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const now = 1_000_000;
    const token = signSession({ exp: now + 100 });
    process.env.OPS_SESSION_SECRET = 'a-totally-different-key';
    expect(verifySession(token, now)).toBeNull();
  });

  it('issueSession sets exp = now + TTL', () => {
    const now = 2_000_000;
    const token = issueSession(now);
    expect(verifySession(token, now)).toEqual({
      exp: now + SESSION_TTL_SECONDS,
    });
  });
});

describe('verifyOpsPassword', () => {
  it('accepts the correct password', () => {
    expect(verifyOpsPassword(PASSWORD)).toBe(true);
  });
  it('rejects a wrong password', () => {
    expect(verifyOpsPassword('nope')).toBe(false);
    expect(verifyOpsPassword(PASSWORD + 'x')).toBe(false);
  });
  it('rejects non-strings and fails closed when env is unset', () => {
    expect(verifyOpsPassword(undefined)).toBe(false);
    expect(verifyOpsPassword(123)).toBe(false);
    delete process.env.OPS_PASSWORD;
    expect(verifyOpsPassword(PASSWORD)).toBe(false);
  });
});

describe('cookie helpers', () => {
  it('issueCookie sets HttpOnly / Secure / SameSite=Strict / Path / Max-Age', () => {
    const c = issueCookie('tok');
    expect(c).toContain('ops_session=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });
  it('clearCookie expires immediately', () => {
    expect(clearCookie()).toContain('Max-Age=0');
  });
  it('readSessionCookie extracts the token from a Cookie header', () => {
    const req = makeReq({
      method: 'GET',
      headers: { cookie: 'other=1; ops_session=abc.def; x=y' },
    });
    expect(readSessionCookie(req)).toBe('abc.def');
    expect(readSessionCookie(makeReq({ method: 'GET' }))).toBeUndefined();
  });
  it('requireSession verifies a cookie end-to-end', () => {
    const now = 5_000_000;
    const token = issueSession(now);
    const req = makeReq({
      method: 'GET',
      headers: { cookie: `ops_session=${token}` },
    });
    expect(requireSession(req, now)).toEqual({
      exp: now + SESSION_TTL_SECONDS,
    });
  });
});

describe('login → me → logout cycle', () => {
  it('logs in, authenticates with the cookie, then logs out', async () => {
    // 1. login with correct password → 200 + Set-Cookie
    const loginRes = makeRes();
    await loginHandler(
      makeReq({ method: 'POST', body: { password: PASSWORD } }) as never,
      loginRes as never,
    );
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    expect(setCookie).toContain('HttpOnly');
    const token = tokenFromSetCookie(setCookie);
    expect(token.length).toBeGreaterThan(0);

    // 2. /me with that cookie → 200 authenticated
    const meRes = makeRes();
    await meHandler(
      makeReq({
        method: 'GET',
        headers: { cookie: `ops_session=${token}` },
      }) as never,
      meRes as never,
    );
    expect(meRes.statusCode).toBe(200);
    expect((meRes.body as { authenticated: boolean }).authenticated).toBe(true);

    // 3. /me with NO cookie → 401
    const meNoCookie = makeRes();
    await meHandler(makeReq({ method: 'GET' }) as never, meNoCookie as never);
    expect(meNoCookie.statusCode).toBe(401);

    // 4. logout → clears the cookie
    const logoutRes = makeRes();
    await logoutHandler(
      makeReq({ method: 'POST' }) as never,
      logoutRes as never,
    );
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    const res = makeRes();
    await loginHandler(
      makeReq({ method: 'POST', body: { password: 'wrong' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 503 when ops auth env is not configured', async () => {
    delete process.env.OPS_PASSWORD;
    const res = makeRes();
    await loginHandler(
      makeReq({ method: 'POST', body: { password: PASSWORD } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(503);
  });

  it('throttles after 5 attempts per IP (429)', async () => {
    // incr returns the running attempt count; the 6th trips the limit.
    let n = 0;
    fakeRedis.incr.mockImplementation(async () => ++n);

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = makeRes();
      await loginHandler(
        makeReq({ method: 'POST', body: { password: PASSWORD } }) as never,
        res as never,
      );
      codes.push(res.statusCode);
    }
    // First 5 succeed (200), the 6th is rate-limited (429) before the
    // password is even checked.
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
