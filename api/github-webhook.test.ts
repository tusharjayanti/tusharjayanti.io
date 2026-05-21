// Unit tests for the GitHub webhook handler. All external services
// (`@vercel/functions` waitUntil, `ingestReadme`) are mocked — no live
// network, no live DB. Covers the spec's 6 scenarios plus the
// length-mismatch HMAC gotcha and the wrong-HTTP-method case.
//
// Mock shape matches VercelRequest/VercelResponse rather than Web
// Request/Response, after sub-spec 3's runtime-mismatch fix realigned
// the handler with the canonical Node-serverless function signature.
// `req.headers` is a plain object with lowercase keys; `req.text()`
// is included on the mock so the readRawBody short-circuit fires and
// tests don't have to async-iterate. `res.status/.send/.end` are
// vi.fn() chainables.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  ingestReadme: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock('../rag/ingest/readme.js', () => ({
  ingestReadme: mocks.ingestReadme,
}));

const SECRET = 'sha256-test-secret-please-rotate';
const ALLOWLISTED_REPO = 'tusharjayanti/vox-agent';

function sign(body: string): string {
  return (
    'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
  );
}

type MockRes = {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  _status: number;
  _body: string;
};

function makeRes(): MockRes {
  const res = {
    _status: 0,
    _body: '',
  } as MockRes;
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.send = vi.fn((body: string) => {
    res._body = body;
    return res;
  });
  res.end = vi.fn((body?: string) => {
    if (body !== undefined) res._body = body;
    return res;
  });
  return res;
}

// VercelRequest mock — plain-object headers (lowercase keys),
// `.method`, and a `.text()` shortcut for body reading so we don't
// have to implement async iteration in every test.
function makeReq(opts: {
  method?: string;
  body?: string;
  signature?: string | null;
  event?: string | null;
}): unknown {
  const headers: Record<string, string> = {};
  if (opts.signature !== null && opts.signature !== undefined) {
    headers['x-hub-signature-256'] = opts.signature;
  }
  if (opts.event !== null && opts.event !== undefined) {
    headers['x-github-event'] = opts.event;
  }
  const body = opts.method === 'GET' ? '' : (opts.body ?? '');
  return {
    method: opts.method ?? 'POST',
    headers,
    text: async () => body,
  };
}

function pushPayload(opts: {
  full_name?: string;
  default_branch?: string;
  ref?: string;
  modified?: string[];
  added?: string[];
}): string {
  const default_branch = opts.default_branch ?? 'main';
  return JSON.stringify({
    ref: opts.ref ?? `refs/heads/${default_branch}`,
    repository: {
      full_name: opts.full_name ?? ALLOWLISTED_REPO,
      default_branch,
    },
    commits: [
      {
        added: opts.added ?? [],
        modified: opts.modified ?? ['README.md'],
        removed: [],
      },
    ],
  });
}

// Lazy import after env + mocks are wired up.
async function loadHandler() {
  const mod = await import('./github-webhook.js');
  return mod.default as (req: unknown, res: unknown) => Promise<void>;
}

describe('github-webhook', () => {
  beforeEach(() => {
    mocks.ingestReadme.mockReset();
    mocks.waitUntil.mockReset();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    mocks.ingestReadme.mockResolvedValue({
      repo: ALLOWLISTED_REPO,
      total_chunks: 1,
      created: 0,
      updated: 0,
      unchanged: 1,
      summary_cache_hits: 1,
      haiku_input_tokens: 0,
      haiku_output_tokens: 0,
      voyage_tokens: 0,
    });
  });

  it('dispatches ingest on a valid signature + README push on default branch', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const req = makeReq({ body, signature: sign(body), event: 'push' });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(202);
    expect(res._body).toBe('accepted');
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    // The promise passed into waitUntil is the (then/catch-wrapped)
    // ingest. Awaiting it lets the underlying ingestReadme fire.
    const promise = mocks.waitUntil.mock.calls[0]![0] as Promise<unknown>;
    await promise;
    expect(mocks.ingestReadme).toHaveBeenCalledWith(ALLOWLISTED_REPO);
  });

  it('returns 405 for non-POST methods', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 401', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = makeRes();
    await handler(
      makeReq({
        body,
        signature: 'sha256=' + 'a'.repeat(64),
        event: 'push',
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects a wrong-length signature with 401 (no throw)', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = makeRes();
    await handler(
      makeReq({ body, signature: 'sha256=short', event: 'push' }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = makeRes();
    await handler(makeReq({ body, event: 'push' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 200 no-op for non-push event types', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'ping' }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('event ignored');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const handler = await loadHandler();
    const body = 'not-json {';
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op for a repo not in the allowlist', async () => {
    const handler = await loadHandler();
    const body = pushPayload({ full_name: 'someone-else/random-repo' });
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('not in allowlist');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op when the push is not on the default branch', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      default_branch: 'main',
      ref: 'refs/heads/feature-branch',
    });
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('not default branch');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op when the push did not touch a root README', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      modified: ['src/index.ts', 'docs/SOMETHING.md'],
      added: ['src/new-file.ts'],
    });
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('README not touched');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('treats a README added (not modified) as a touch', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      modified: [],
      added: ['README.md'],
    });
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(202);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('matches README path case-insensitively', async () => {
    const handler = await loadHandler();
    const body = pushPayload({ modified: ['readme.markdown'] });
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(202);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('rejects when GITHUB_WEBHOOK_SECRET is unset', async () => {
    const handler = await loadHandler();
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = pushPayload({});
    const res = makeRes();
    await handler(
      makeReq({ body, signature: sign(body), event: 'push' }),
      res,
    );
    expect(res._status).toBe(401);
  });
});
