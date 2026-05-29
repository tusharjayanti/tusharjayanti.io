// llm_judge — a judge model returns yes/no on a free-form criterion.
// The one assertion type with an LLM in the path, so a tolerance band
// applies at the threshold layer.
//
// The judge function is injectable so the engine and tests stay
// deterministic; `defaultJudge` lazily constructs an Anthropic client
// and calls Haiku at temperature 0. The default path is dormant until
// llm_judge assertions are authored and ANTHROPIC_API_KEY is
// configured in the eval environment.

import type { AssertionResult, ResponseContext } from './types.js';

const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

export type JudgeFn = (
  criterion: string,
  responseText: string,
  model: string,
) => Promise<boolean>;

async function defaultJudge(
  criterion: string,
  responseText: string,
  model: string,
): Promise<boolean> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model,
    max_tokens: 8,
    temperature: 0,
    system:
      'You are a strict evaluator. Answer the question about the RESPONSE with exactly "yes" or "no".',
    messages: [
      {
        role: 'user',
        content: `CRITERION: ${criterion}\n\nRESPONSE:\n${responseText}\n\nDoes the RESPONSE satisfy the CRITERION? Answer yes or no.`,
      },
    ],
  });
  const text = message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
    .toLowerCase();
  return text.startsWith('y');
}

export async function llmJudge(
  response: ResponseContext,
  params: { criterion: string; model?: string },
  judge: JudgeFn = defaultJudge,
): Promise<AssertionResult> {
  const model = params.model ?? DEFAULT_JUDGE_MODEL;
  try {
    const verdict = await judge(params.criterion, response.text, model);
    return {
      type: 'llm_judge',
      passed: verdict,
      detail: `criterion="${params.criterion}" → ${verdict ? 'yes' : 'no'} (${model})`,
    };
  } catch (err) {
    return {
      type: 'llm_judge',
      passed: false,
      detail: `judge error (${model}): ${(err as Error).message}`,
    };
  }
}
