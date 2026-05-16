import { CANARY_TOKEN } from './_systemPrompt.js';

export type InjectionResult = { hit: boolean; reason?: string };

const PATTERNS: { regex: RegExp; reason: string }[] = [
  {
    regex:
      /ignore ((all|previous|prior)\s+){1,3}(instructions|prompts|context)/i,
    reason: 'override-instructions',
  },
  {
    regex: /disregard (the )?(above|previous|prior|system)/i,
    reason: 'disregard-prior',
  },
  {
    regex: /reveal (the |your |my |its |our )?(system|hidden) prompt/i,
    reason: 'prompt-extraction',
  },
  { regex: /\bDAN\b/i, reason: 'dan-roleplay' },
  { regex: /jailbreak/i, reason: 'jailbreak-keyword' },
  { regex: /developer mode/i, reason: 'developer-mode' },
  // (now |actually ) is REQUIRED (no `?`) so "you are an impressive engineer"
  // doesn't trip — only "you are now X" / "you are actually X" patterns do.
  { regex: /you are (now |actually )(?!Tushar)/i, reason: 'role-hijack' },
];

export function detectInjection(text: string): InjectionResult {
  if (text.includes(CANARY_TOKEN)) {
    return { hit: true, reason: 'canary-leak' };
  }
  for (const { regex, reason } of PATTERNS) {
    if (regex.test(text)) return { hit: true, reason };
  }
  return { hit: false };
}
