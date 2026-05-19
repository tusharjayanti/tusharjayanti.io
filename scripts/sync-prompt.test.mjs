import { describe, it, expect, afterEach } from 'vitest';
import {
  generateCanary,
  substituteCanary,
  getCanary,
  renderTs,
  computePromptHash,
  PROMPT_NAME,
} from './sync-prompt.mjs';

describe('generateCanary', () => {
  it('matches the cnry_<16-hex> format', () => {
    expect(generateCanary()).toMatch(/^cnry_[0-9a-f]{16}$/);
  });

  it('produces different values on consecutive calls', () => {
    expect(generateCanary()).not.toBe(generateCanary());
  });
});

describe('substituteCanary', () => {
  it('replaces {{CANARY_TOKEN}} with the canary value', () => {
    const template = 'canary: {{CANARY_TOKEN}}\n\nrest of prompt';
    const out = substituteCanary(template, 'cnry_abcdef1234567890');
    expect(out).toContain('cnry_abcdef1234567890');
    expect(out).not.toContain('{{CANARY_TOKEN}}');
  });
});

describe('getCanary', () => {
  const original = process.env.CANARY_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.CANARY_TOKEN;
    else process.env.CANARY_TOKEN = original;
  });

  it('uses CANARY_TOKEN env var as override when set', () => {
    process.env.CANARY_TOKEN = 'cnry_envoverride0';
    expect(getCanary()).toBe('cnry_envoverride0');
  });
});

describe('renderTs', () => {
  it('produces a file with the expected TypeScript export shape', () => {
    const out = renderTs('cnry_abc', 'body text', 'a1b2c3d4e5f6', 7);
    expect(out).toContain('export const CANARY_TOKEN: string =');
    expect(out).toContain('"cnry_abc"');
    expect(out).toContain('export const PROMPT_NAME: string =');
    expect(out).toContain(`"${PROMPT_NAME}"`);
    expect(out).toContain('export const PROMPT_VERSION: string =');
    expect(out).toContain('"a1b2c3d4e5f6"');
    expect(out).toContain('export const PROMPT_VERSION_NUMBER: number = 7');
  });
});

describe('computePromptHash', () => {
  it('is deterministic — same input produces same hash', () => {
    const a = computePromptHash('some prompt body');
    const b = computePromptHash('some prompt body');
    expect(a).toBe(b);
  });

  it('differs across different inputs', () => {
    expect(computePromptHash('a')).not.toBe(computePromptHash('b'));
  });

  it('matches the [a-f0-9]{12} format', () => {
    expect(computePromptHash('anything')).toMatch(/^[a-f0-9]{12}$/);
  });

  it('produces the same hash for the same content under different canaries', () => {
    const a = 'canary: cnry_aaaaaaaaaaaaaaaa\n\nrest of prompt';
    const b = 'canary: cnry_bbbbbbbbbbbbbbbb\n\nrest of prompt';
    expect(computePromptHash(a)).toBe(computePromptHash(b));
  });

  it('produces different hashes for different content under the same canary', () => {
    const a = 'canary: cnry_same1234567890\n\nfirst body';
    const b = 'canary: cnry_same1234567890\n\nsecond body';
    expect(computePromptHash(a)).not.toBe(computePromptHash(b));
  });
});
