// Unit tests for the terminal `history` command's pure helper.
// The dispatch-level behavior (autoplay excluded, clear-doesn't-touch-
// history) is enforced by Terminal.tsx's existing `addToHistory: false`
// flag and the separation of `clear` from `setHistory` — both
// pre-existing and unchanged by the history-command commit.

import { describe, it, expect } from 'vitest';
import { formatHistory } from './index';

describe('formatHistory', () => {
  it('returns an empty string for an empty history', () => {
    expect(formatHistory([])).toBe('');
  });

  it('renders a single entry with right-aligned 4-char number', () => {
    expect(formatHistory(['whoami'])).toBe('   1  whoami');
  });

  it('joins multiple entries on newlines, each right-aligned', () => {
    expect(formatHistory(['whoami', 'ls', 'cat experience'])).toBe(
      '   1  whoami\n   2  ls\n   3  cat experience',
    );
  });

  it('preserves the right-alignment as numbers cross digit boundaries', () => {
    const entries = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`);
    const out = formatHistory(entries);
    const lines = out.split('\n');
    expect(lines[0]).toBe('   1  cmd-1');
    expect(lines[8]).toBe('   9  cmd-9');
    expect(lines[9]).toBe('  10  cmd-10');
    expect(lines[11]).toBe('  12  cmd-12');
    // Confirm the field is consistently 4 chars wide before the
    // two-space gap.
    for (const line of lines) {
      expect(line.slice(0, 6)).toMatch(/^ {2,3}\d{1,2}  $/);
    }
  });

  it('renders free-text chat queries the same as built-in commands', () => {
    // Chat queries arrive at dispatch the same way as commands and
    // get appended to the history array verbatim. No special-casing.
    const entries = ['whoami', 'tell me about vox-agent', 'help'];
    expect(formatHistory(entries)).toBe(
      '   1  whoami\n   2  tell me about vox-agent\n   3  help',
    );
  });
});
