import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  SpanProcessorCtor: vi.fn(),
  setLangfuseTracerProvider: vi.fn(),
}));

// v5 is OTEL-based: there is no `new Langfuse()` client to assert on any
// more. The equivalent construction site is the LangfuseSpanProcessor, so
// that is what these tests pin — including `exportMode: 'immediate'`, which
// carries over the intent of v3's `flushAt: 1` on Edge.
vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class {
    constructor(opts: unknown) {
      mocks.SpanProcessorCtor(opts);
    }
    async forceFlush() {}
  },
}));

vi.mock('@langfuse/tracing', () => ({
  setLangfuseTracerProvider: mocks.setLangfuseTracerProvider,
}));

const { initTracing, makeSystemPromptHandle } = await import('./_langfuse.js');
const { __resetTracingForTests } = await import('./_otel.js');

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

function setEnv() {
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
  process.env.LANGFUSE_SECRET_KEY = 'sk-test';
  process.env.LANGFUSE_BASE_URL = 'https://jp.cloud.langfuse.com';
}

describe('initTracing', () => {
  beforeEach(() => {
    __resetTracingForTests();
    mocks.SpanProcessorCtor.mockClear();
    mocks.setLangfuseTracerProvider.mockClear();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('returns false when env vars are missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(initTracing()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('langfuse'));
    expect(mocks.SpanProcessorCtor).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('installs a tracer provider when all three env vars are set', () => {
    setEnv();
    expect(initTracing()).toBe(true);
    expect(mocks.SpanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.setLangfuseTracerProvider).toHaveBeenCalledTimes(1);
  });

  it('initialises once on repeat calls (singleton)', () => {
    setEnv();
    expect(initTracing()).toBe(true);
    expect(initTracing()).toBe(true);
    expect(mocks.SpanProcessorCtor).toHaveBeenCalledTimes(1);
  });

  it('passes exportMode immediate and the right baseUrl to the processor', () => {
    setEnv();
    initTracing();
    expect(mocks.SpanProcessorCtor).toHaveBeenCalledWith({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://jp.cloud.langfuse.com',
      exportMode: 'immediate',
    });
  });
});

describe('makeSystemPromptHandle', () => {
  it('returns null when no real Langfuse version is available', () => {
    expect(makeSystemPromptHandle('tarvis-system-prompt', 0)).toBeNull();
    expect(makeSystemPromptHandle('tarvis-system-prompt', -1)).toBeNull();
  });

  it('returns a plain prompt handle for a real version', () => {
    expect(makeSystemPromptHandle('tarvis-system-prompt', 7)).toEqual({
      name: 'tarvis-system-prompt',
      version: 7,
      isFallback: false,
    });
  });
});
