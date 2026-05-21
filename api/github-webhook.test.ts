// Unit tests for the GitHub webhook handler. All external services
// (`@vercel/functions` waitUntil, `ingestReadme`) are mocked — no live
// network, no live DB. Covers the spec's 6 scenarios plus the
// length-mismatch HMAC gotcha and the wrong-HTTP-method case.

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

function makeRequest(opts: {
  method?: string;
  body?: string;
  signature?: string | null;
  event?: string | null;
}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.signature !== null && opts.signature !== undefined) {
    headers['x-hub-signature-256'] = opts.signature;
  }
  if (opts.event !== null && opts.event !== undefined) {
    headers['x-github-event'] = opts.event;
  }
  return new Request('http://localhost/api/github-webhook', {
    method: opts.method ?? 'POST',
    headers,
    body: opts.method === 'GET' ? undefined : (opts.body ?? ''),
  });
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
  const { default: handler } = await import('./github-webhook.js');
  return handler;
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
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('accepted');
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    // The promise passed into waitUntil is the (then/catch-wrapped)
    // ingest. Awaiting it lets the underlying ingestReadme fire.
    const promise = mocks.waitUntil.mock.calls[0]![0] as Promise<unknown>;
    await promise;
    expect(mocks.ingestReadme).toHaveBeenCalledWith(ALLOWLISTED_REPO);
  });

  it('returns 405 for non-POST methods', async () => {
    const handler = await loadHandler();
    const res = await handler(makeRequest({ method: 'GET' }));
    expect(res.status).toBe(405);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 401', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = await handler(
      makeRequest({
        body,
        signature: 'sha256=' + 'a'.repeat(64),
        event: 'push',
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects a wrong-length signature with 401 (no throw)', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = await handler(
      makeRequest({ body, signature: 'sha256=short', event: 'push' }),
    );
    expect(res.status).toBe(401);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = await handler(makeRequest({ body, event: 'push' }));
    expect(res.status).toBe(401);
  });

  it('returns 200 no-op for non-push event types', async () => {
    const handler = await loadHandler();
    const body = pushPayload({});
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'ping' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('event ignored');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const handler = await loadHandler();
    const body = 'not-json {';
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op for a repo not in the allowlist', async () => {
    const handler = await loadHandler();
    const body = pushPayload({ full_name: 'someone-else/random-repo' });
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('not in allowlist');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op when the push is not on the default branch', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      default_branch: 'main',
      ref: 'refs/heads/feature-branch',
    });
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('not default branch');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 no-op when the push did not touch a root README', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      modified: ['src/index.ts', 'docs/SOMETHING.md'],
      added: ['src/new-file.ts'],
    });
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('README not touched');
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it('treats a README added (not modified) as a touch', async () => {
    const handler = await loadHandler();
    const body = pushPayload({
      modified: [],
      added: ['README.md'],
    });
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(202);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('matches README path case-insensitively', async () => {
    const handler = await loadHandler();
    const body = pushPayload({ modified: ['readme.markdown'] });
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(202);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('rejects when GITHUB_WEBHOOK_SECRET is unset', async () => {
    const handler = await loadHandler();
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = pushPayload({});
    const res = await handler(
      makeRequest({ body, signature: sign(body), event: 'push' }),
    );
    expect(res.status).toBe(401);
  });
});
