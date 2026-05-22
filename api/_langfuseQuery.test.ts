// Unit tests for the Langfuse REST aggregator. All HTTP calls are
// mocked via vi.stubGlobal('fetch', ...) — no live Langfuse hits.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { makeLangfuseAggregate } from './_langfuseQuery.js';

const ENV = {
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
  LANGFUSE_BASE_URL: 'https://example.langfuse.test',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('makeLangfuseAggregate', () => {
  const originalEnv = {
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
  };

  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = ENV.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = ENV.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = ENV.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.LANGFUSE_PUBLIC_KEY = originalEnv.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = originalEnv.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = originalEnv.LANGFUSE_BASE_URL;
  });

  it('returns null when env vars are missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(makeLangfuseAggregate()).toBeNull();
  });

  it('sumTokens hits /api/public/observations?type=GENERATION (not the traces endpoint)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/api/public/observations')) {
          return jsonResponse({
            data: [
              { id: 'o1', totalTokens: 1915, usage: { total: 1915 } },
              { id: 'o2', totalTokens: 392, usage: { total: 392 } },
              { id: 'o3', totalTokens: 1058 },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const lf = makeLangfuseAggregate();
    expect(lf).not.toBeNull();
    const total = await lf!.sumTokens(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBe(1915 + 392 + 1058);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/public/observations');
    expect(calls[0]).toContain('type=GENERATION');
    // Token aggregation must NOT be routed through the traces endpoint.
    expect(calls[0]).not.toContain('/api/public/traces');
  });

  it('sumTokens falls back to usage.total when totalTokens is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: 'o1', usage: { total: 500 } },
            { id: 'o2', totalTokens: 200 },
            { id: 'o3' /* no usage field at all */ },
          ],
        }),
      ),
    );
    const lf = makeLangfuseAggregate()!;
    const total = await lf.sumTokens(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(total).toBe(700);
  });

  it('countTraces hits /api/public/traces filtered by name=chat-turn', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countTraces(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(count).toBe(3);
    expect(calls[0]).toContain('/api/public/traces');
    expect(calls[0]).toContain('name=chat-turn');
  });

  it('countToolExecutions hits /api/public/observations?type=SPAN&name=tool-execution', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [{ id: 's1' }, { id: 's2' }],
        });
      }),
    );
    const lf = makeLangfuseAggregate()!;
    const count = await lf.countToolExecutions(
      '2026-05-15T00:00:00Z',
      '2026-05-22T00:00:00Z',
    );
    expect(count).toBe(2);
    expect(calls[0]).toContain('/api/public/observations');
    expect(calls[0]).toContain('type=SPAN');
    expect(calls[0]).toContain('name=tool-execution');
  });

  it('caches each metric so concurrent calls share one HTTP request', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('type=GENERATION')) {
        return jsonResponse({ data: [{ id: 'o1', totalTokens: 100 }] });
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const lf = makeLangfuseAggregate()!;
    const [a, b] = await Promise.all([
      lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
      lf.sumTokens('2026-05-15T00:00:00Z', '2026-05-22T00:00:00Z'),
    ]);
    expect(a).toBe(100);
    expect(b).toBe(100);
    // Only one fetch fired across two calls — the second await
    // resolved the cached promise.
    const generationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('type=GENERATION'),
    );
    expect(generationCalls).toHaveLength(1);
  });
});
