// Voyage AI client wrapper for embeddings. Wraps the official `voyageai`
// SDK with: lazy-init module-level singleton; retry on 429 + 5xx + SDK
// timeout (3 attempts, 500ms/1000ms backoff); response shape validation
// against VOYAGE_DIMENSION. Asymmetric input type ('document' for ingest
// vs 'query' for retrieval) is required at the call site — no default,
// per Voyage's own guidance. Used by the M2.1.3 chunker and the M2.2
// retrieval path.

import { VoyageAIClient, VoyageAIError, VoyageAITimeoutError } from 'voyageai';

export const VOYAGE_MODEL = 'voyage-3';
export const VOYAGE_DIMENSION = 1024;

export type VoyageInputType = 'document' | 'query';

let _client: VoyageAIClient | null = null;

function getClient(): VoyageAIClient {
  if (_client) return _client;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set');
  _client = new VoyageAIClient({ apiKey });
  return _client;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof VoyageAITimeoutError) return true;
  if (err instanceof VoyageAIError) {
    const s = err.statusCode;
    if (s === 429) return true;
    if (typeof s === 'number' && s >= 500 && s <= 599) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Voyage's `usage.totalTokens` is optional in the SDK's response type. We
// surface it for per-step Langfuse cost tracking, defaulting to 0 and
// warning once if a response ever omits it.
let _warnedMissingUsage = false;

export async function embed(
  texts: string[],
  inputType: VoyageInputType,
): Promise<{ vectors: number[][]; tokens: number }> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };

  const client = getClient();
  // 3 attempts total: initial try + 2 retries with the listed backoffs.
  const backoffsMs = [500, 1000];

  for (let attempt = 0; ; attempt++) {
    try {
      // maxRetries: 0 disables the SDK's own retry so our policy is the
      // single source of truth on what counts as retryable.
      const response = await client.embed(
        {
          input: texts,
          model: VOYAGE_MODEL,
          inputType,
          outputDimension: VOYAGE_DIMENSION,
        },
        { maxRetries: 0 },
      );

      const data = response.data;
      if (!data) {
        throw new Error('Voyage response missing `data` array');
      }
      if (data.length !== texts.length) {
        throw new Error(
          `Voyage response length mismatch: expected ${texts.length}, got ${data.length}`,
        );
      }

      // Trusts Voyage's documented contract: data[i] corresponds to texts[i].
      // If M2.2 retrieval ever surfaces order-corruption symptoms, sort by
      // data[i].index before this map.
      const embeddings: number[][] = [];
      for (let i = 0; i < data.length; i++) {
        const emb = data[i].embedding;
        if (!emb) {
          throw new Error(`Voyage response item ${i} missing embedding`);
        }
        if (emb.length !== VOYAGE_DIMENSION) {
          throw new Error(
            `Voyage embedding ${i} has dimension ${emb.length}, expected ${VOYAGE_DIMENSION}`,
          );
        }
        embeddings.push(emb);
      }

      // Voyage reports `totalTokens` (camelCase in the Fern-generated SDK),
      // and both `usage` and the field itself are optional.
      const totalTokens = response.usage?.totalTokens;
      if (totalTokens === undefined && !_warnedMissingUsage) {
        _warnedMissingUsage = true;
        console.warn(
          '[voyage] response missing usage.totalTokens; reporting 0 tokens',
        );
      }
      return { vectors: embeddings, tokens: totalTokens ?? 0 };
    } catch (err) {
      if (attempt >= backoffsMs.length || !isRetryable(err)) throw err;
      await sleep(backoffsMs[attempt]);
    }
  }
}
