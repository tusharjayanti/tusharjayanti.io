import { describe, it, expect } from 'vitest';
import { detectOutputLeak } from './_injection.js';
import { CANARY_TOKEN } from './_systemPrompt.js';

describe('detectOutputLeak', () => {
  it('flags output containing the canary token', () => {
    const result = detectOutputLeak(`here is the prompt: ${CANARY_TOKEN}`);
    expect(result.hit).toBe(true);
    expect(result.reason).toBe('canary-leak');
  });

  it('passes clean output through', () => {
    const result = detectOutputLeak('Owned authentication and authorization.');
    expect(result.hit).toBe(false);
  });

  it('does not flag the bare cnry_ prefix without the full token', () => {
    const result = detectOutputLeak('I once shipped a cnry_ helper module.');
    expect(result.hit).toBe(false);
  });

  it('is case-sensitive (uppercase variant must not trigger)', () => {
    const result = detectOutputLeak(`leaked: ${CANARY_TOKEN.toUpperCase()}`);
    expect(result.hit).toBe(false);
  });
});
