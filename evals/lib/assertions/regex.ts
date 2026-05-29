// regex — response text matches the pattern. Default flags "i".

import type { AssertionResult, ResponseContext } from './types.js';

export function regexMatch(
  response: ResponseContext,
  params: { pattern: string; flags?: string },
): AssertionResult {
  const flags = params.flags ?? 'i';
  let re: RegExp;
  try {
    re = new RegExp(params.pattern, flags);
  } catch (err) {
    return {
      type: 'regex',
      passed: false,
      detail: `invalid regex /${params.pattern}/${flags}: ${(err as Error).message}`,
    };
  }
  const ok = re.test(response.text);
  return {
    type: 'regex',
    passed: ok,
    detail: ok
      ? `matched /${params.pattern}/${flags}`
      : `no match for /${params.pattern}/${flags}`,
  };
}
