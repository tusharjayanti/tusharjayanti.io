import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @supabase/supabase-js's createClient. We return a sentinel object
// so the singleton-identity check has something stable to compare against,
// and so we can assert the auth options passed at construction without
// actually instantiating the realtime / postgrest stack.
const createClientMock = vi.hoisted(() => vi.fn());
const fakeClient = vi.hoisted(() => ({ __fakeSupabase: true }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function loadGetSupabaseClient(): Promise<
  typeof import('./_supabase.js').getSupabaseClient
> {
  vi.resetModules();
  const mod = await import('./_supabase.js');
  return mod.getSupabaseClient;
}

describe('getSupabaseClient', () => {
  beforeEach(() => {
    createClientMock.mockReset();
    createClientMock.mockReturnValue(fakeClient);
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  });

  afterEach(() => {
    restoreEnv();
  });

  it('throws when SUPABASE_URL is missing', async () => {
    delete process.env.SUPABASE_URL;
    const getSupabaseClient = await loadGetSupabaseClient();
    expect(() => getSupabaseClient()).toThrow('SUPABASE_URL is not set');
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('throws when SUPABASE_SECRET_KEY is missing', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const getSupabaseClient = await loadGetSupabaseClient();
    expect(() => getSupabaseClient()).toThrow('SUPABASE_SECRET_KEY is not set');
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns the client when both env vars are present', async () => {
    const getSupabaseClient = await loadGetSupabaseClient();
    const client = getSupabaseClient();
    expect(client).toBe(fakeClient);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('returns the same instance on repeat calls (singleton)', async () => {
    const getSupabaseClient = await loadGetSupabaseClient();
    const a = getSupabaseClient();
    const b = getSupabaseClient();
    expect(a).toBe(b);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('passes auth options with persistSession=false and autoRefreshToken=false', async () => {
    const getSupabaseClient = await loadGetSupabaseClient();
    getSupabaseClient();
    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'sb_secret_test',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  });
});
