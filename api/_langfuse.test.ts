import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  LangfuseCtor: vi.fn(),
}));

vi.mock('langfuse', () => ({
  Langfuse: class {
    constructor(opts: unknown) {
      mocks.LangfuseCtor(opts);
    }
  },
}));

const { getLangfuse, __resetLangfuseForTests } = await import('./_langfuse.js');

const originalEnv = {
  LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
  LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('getLangfuse', () => {
  beforeEach(() => {
    __resetLangfuseForTests();
    mocks.LangfuseCtor.mockClear();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('returns null when env vars are missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getLangfuse()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('langfuse'));
    expect(mocks.LangfuseCtor).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns a client when all three env vars are set', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_BASE_URL = 'https://jp.cloud.langfuse.com';
    const client = getLangfuse();
    expect(client).not.toBeNull();
    expect(mocks.LangfuseCtor).toHaveBeenCalledTimes(1);
  });

  it('returns the same instance on repeat calls (singleton)', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_BASE_URL = 'https://jp.cloud.langfuse.com';
    const a = getLangfuse();
    const b = getLangfuse();
    expect(a).toBe(b);
    expect(mocks.LangfuseCtor).toHaveBeenCalledTimes(1);
  });

  it('passes flushAt: 1 and the right baseUrl to the constructor', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_BASE_URL = 'https://jp.cloud.langfuse.com';
    getLangfuse();
    expect(mocks.LangfuseCtor).toHaveBeenCalledWith({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://jp.cloud.langfuse.com',
      flushAt: 1,
    });
  });
});
