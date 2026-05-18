import { describe, it, expect, afterEach } from 'vitest';
import {
  generateCanary,
  substituteCanary,
  getCanary,
  renderTs,
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
    const out = renderTs('cnry_abc', 'body text');
    expect(out).toContain('export const CANARY_TOKEN: string =');
    expect(out).toContain('"cnry_abc"');
  });
});
