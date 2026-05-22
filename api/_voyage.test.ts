import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

// Mock the voyageai SDK at the module boundary. The mocked classes are
// what the source code's `instanceof` checks see, so test-thrown errors
// pass the retry-classifier branches the same way real ones would.
const embedMock = vi.hoisted(() => vi.fn());

vi.mock('voyageai', () => {
  class VoyageAIError extends Error {
    statusCode?: number;
    constructor({
      message,
      statusCode,
    }: {
      message?: string;
      statusCode?: number;
    }) {
      super(message ?? 'voyage error');
      this.statusCode = statusCode;
    }
  }
  class VoyageAITimeoutError extends Error {
    constructor() {
      super('voyage timeout');
    }
  }
  class VoyageAIClient {
    embed = embedMock;
  }
  return { VoyageAIClient, VoyageAIError, VoyageAITimeoutError };
});

const originalEnv = {
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeEmbedding(dim = 1024, fill = 0): number[] {
  return new Array<number>(dim).fill(fill);
}

function embedResponse(
  count: number,
  dim = 1024,
): {
  data: { embedding: number[]; index: number }[];
} {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      embedding: makeEmbedding(dim),
      index: i,
    })),
  };
}

async function loadEmbed(): Promise<typeof import('./_voyage.js').embed> {
  vi.resetModules();
  const mod = await import('./_voyage.js');
  return mod.embed;
}

async function loadVoyageError(): Promise<
  typeof import('voyageai').VoyageAIError
> {
  const mod = await import('voyageai');
  return mod.VoyageAIError;
}

describe('embed', () => {
  beforeEach(() => {
    embedMock.mockReset();
    process.env.VOYAGE_API_KEY = 'test-key';
  });

  afterEach(() => {
    restoreEnv();
    vi.useRealTimers();
  });

  it('returns [] for empty input and does not call the SDK', async () => {
    const embed = await loadEmbed();
    const result = await embed([], 'document');
    expect(result).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('returns embeddings with shape matching input length and 1024-dim each', async () => {
    const embed = await loadEmbed();
    embedMock.mockResolvedValue(embedResponse(3));
    const result = await embed(['a', 'b', 'c'], 'document');
    expect(result).toHaveLength(3);
    for (const emb of result) {
      expect(emb).toHaveLength(1024);
    }
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the SDK returns a wrong-length data array', async () => {
    const embed = await loadEmbed();
    embedMock.mockResolvedValue(embedResponse(2));
    await expect(embed(['a', 'b', 'c'], 'document')).rejects.toThrow(
      /length mismatch: expected 3, got 2/,
    );
  });

  it('throws when an embedding has the wrong dimension', async () => {
    const embed = await loadEmbed();
    embedMock.mockResolvedValue(embedResponse(1, 512));
    await expect(embed(['a'], 'document')).rejects.toThrow(
      /dimension 512, expected 1024/,
    );
  });

  it('throws on first call when VOYAGE_API_KEY is missing', async () => {
    delete process.env.VOYAGE_API_KEY;
    const embed = await loadEmbed();
    await expect(embed(['a'], 'document')).rejects.toThrow(
      'VOYAGE_API_KEY is not set',
    );
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('retries on a 429 then succeeds on the second call', async () => {
    vi.useFakeTimers();
    const VoyageAIError = await loadVoyageError();
    const embed = await loadEmbed();
    embedMock
      .mockRejectedValueOnce(
        new VoyageAIError({ statusCode: 429, message: 'rate limited' }),
      )
      .mockResolvedValueOnce(embedResponse(1));

    const promise = embed(['a'], 'document');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it('retries on a 5xx then succeeds on the second call', async () => {
    vi.useFakeTimers();
    const VoyageAIError = await loadVoyageError();
    const embed = await loadEmbed();
    embedMock
      .mockRejectedValueOnce(
        new VoyageAIError({ statusCode: 502, message: 'bad gateway' }),
      )
      .mockResolvedValueOnce(embedResponse(1));

    const promise = embed(['a'], 'document');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a non-retryable 4xx (401)', async () => {
    const VoyageAIError = await loadVoyageError();
    const embed = await loadEmbed();
    embedMock.mockRejectedValue(
      new VoyageAIError({ statusCode: 401, message: 'unauthorized' }),
    );

    await expect(embed(['a'], 'document')).rejects.toThrow('unauthorized');
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting all 3 attempts', async () => {
    vi.useFakeTimers();
    const VoyageAIError = await loadVoyageError();
    const embed = await loadEmbed();
    embedMock.mockRejectedValue(
      new VoyageAIError({ statusCode: 500, message: 'final' }),
    );

    const promise = embed(['a'], 'document');
    // Attach the rejection assertion BEFORE advancing timers so vitest
    // doesn't see a transient "unhandled rejection" in the gap between
    // the timer-driven throw and the test re-awaiting the promise.
    const assertion = expect(promise).rejects.toThrow('final');
    // Two backoffs of 500ms and 1000ms between the three attempts.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(embedMock).toHaveBeenCalledTimes(3);
  });

  it('makes no SDK call when input is empty (explicit no-op guarantee)', async () => {
    const embed = await loadEmbed();
    await embed([], 'query');
    const calls = (embedMock as Mock).mock.calls;
    expect(calls.length).toBe(0);
  });
});
