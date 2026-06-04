// Tests for the hidden easter-egg commands. Each egg is a registered
// command (Terminal.tsx routes unknown first tokens to chat, so an
// unregistered egg would just become a question to Tarvis) and each is
// absent from the hand-written `help` block. We drive run() through a
// minimal ctx that collects appended entries, then render the resulting
// nodes to static markup to assert on the visible copy. No DOM needed.
//
// Eggs now reveal their lines as a timed sequence (cumulative setTimeout),
// so the whole suite runs under fake timers and run() drains them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { commands } from './index';
import type { ScrollbackEntry, CommandContext } from './index';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(line: string) {
  const entries: ScrollbackEntry[] = [];
  const [name, ...args] = line.trim().split(/\s+/);
  const ctx = {
    args,
    raw: line.trim(),
    append: (e: ScrollbackEntry) => entries.push(e),
    updateById: () => {},
    clear: () => {},
    startedAt: 0,
    chatSignal: new AbortController().signal,
    history: [],
    clearHistory: () => {},
  } satisfies CommandContext;
  return { entries, ctx, name };
}

// renderToStaticMarkup HTML-escapes quotes/apostrophes; decode the few
// entities our copy produces so substring asserts read the plain text.
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Render every appended node to a single text blob for substring asserts.
function text(entries: ScrollbackEntry[]): string {
  return entries
    .map((e) => {
      if (e.kind === 'output' || e.kind === 'comment') {
        return decode(renderToStaticMarkup(e.node as ReactElement));
      }
      if (e.kind === 'error' || e.kind === 'command') return e.text;
      return '';
    })
    .join('\n');
}

// Run a command line through its registered handler and return the text.
// Drains the reveal timers so assertions see the full sequence; sync
// commands schedule no timers, so runAllTimers is a no-op for them.
function run(line: string): string {
  const { entries, ctx, name } = harness(line);
  const cmd = commands[name];
  expect(cmd, `command "${name}" is registered`).toBeDefined();
  cmd.run(ctx);
  vi.runAllTimers();
  return text(entries);
}

const EGG_NAMES = [
  'sudo',
  'rm',
  'vim',
  'emacs',
  'coffee',
  'tushar',
  'sl',
  'man',
  '42',
];

describe('egg registration and help hiding', () => {
  it('registers every egg as a dispatchable command', () => {
    for (const name of EGG_NAMES) {
      expect(commands[name], `${name} should be registered`).toBeDefined();
    }
  });

  it('keeps every egg out of the help block', () => {
    const { entries, ctx } = harness('help');
    commands.help.run(ctx);
    const help = text(entries);
    for (const name of EGG_NAMES) {
      // `rm` would substring-match unrelated words, so assert on the
      // command-name span markup the help block uses for real commands.
      expect(help).not.toContain(`>${name}<`);
    }
    // Sanity: a genuinely-listed command IS present in that form.
    expect(help).toContain('>hire-me<');
  });
});

describe('sudo', () => {
  it('plays the escalation theater and grants nothing', () => {
    const out = run('sudo');
    expect(out).toContain('verifying identity');
    expect(out).toContain('elevated smart-ass permissions');
    expect(out).toContain('you feel powerful');
  });
  it('ignores args — sudo <anything> runs the same gag', () => {
    expect(run('sudo rm -rf /')).toContain('elevated smart-ass permissions');
  });
});

describe('rm', () => {
  it('taunts on bare rm (no -rf)', () => {
    const out = run('rm');
    expect(out).toContain('rm?');
    expect(out).toContain("where's the -rf");
  });

  it('taunts on rm with non-force args', () => {
    expect(run('rm somefile')).toContain('rm?');
  });

  it('fake-nukes then no-ops on rm -rf and its target variants', () => {
    for (const line of ['rm -rf', 'rm -rf /', 'rm -rf ~', 'rm -rf *']) {
      const out = run(line);
      expect(out, line).toContain('nuking everything');
      expect(out, line).toContain('really? you think that works here?');
      expect(out, line).toContain('version-control my mistakes');
    }
  });
});

describe('vim / emacs', () => {
  it('vim is a one-way door', () => {
    const out = run('vim');
    expect(out).toContain('opening vim');
    expect(out).toContain('0 idea how to leave');
    expect(out).toContain('you live here now');
  });
  it('emacs ribs the user', () => {
    const out = run('emacs');
    expect(out).toContain('M-x doctor');
    expect(out).toContain('pinky has already filed a complaint');
  });
});

describe('tushar', () => {
  it('--version resolves metadata then prints the changelog', () => {
    const out = run('tushar --version');
    expect(out).toContain('resolving build metadata');
    expect(out).toContain('tushar 7.x (latest)');
    expect(out).toContain('production');
    expect(out).toContain('wontfix');
  });

  it('bare tushar does not print the changelog', () => {
    const out = run('tushar');
    expect(out).toContain("that's me");
    expect(out).not.toContain('wontfix');
  });
});

describe('man / 42', () => {
  it('man <x> reports no entry for x', () => {
    expect(run('man grep')).toContain('no manual entry for grep.');
  });
  it('bare man asks which page', () => {
    expect(run('man')).toContain('What manual page do you want?');
  });
  it('42 counts down to the punchline', () => {
    const out = run('42');
    expect(out).toContain('computing the answer');
    expect(out).toContain('7.5 million years');
    expect(out).toContain('now what was the question?');
  });
});

describe('whoami', () => {
  it('still prints the normal bio', () => {
    const out = run('whoami');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('matching "recruiter"');
  });

  it('fires the recruiter pitch on the piped grep pattern', () => {
    const out = run('whoami | grep recruiter');
    expect(out).toContain('scanning for recruiters');
    expect(out).toContain('match found');
    expect(out).toContain('matching "recruiter"');
    expect(out).toContain('Since you grepped for it');
    expect(out).toContain('hire-me');
  });

  it('still fires when the pipe is glued to grep', () => {
    expect(run('whoami |grep recruiter')).toContain('matching "recruiter"');
  });
});

describe('coffee', () => {
  it('reveals the cup and brew steps on timers, punchline last', () => {
    const { entries, ctx } = harness('coffee');
    commands.coffee.run(ctx);
    // Nothing synchronous — the whole sequence is on cumulative timers.
    expect(entries).toHaveLength(0);
    vi.runAllTimers();
    expect(entries).toHaveLength(5);
    const out = text(entries);
    expect(out).toContain('grinding beans');
    expect(out).toContain('brewing...');
    expect(out).toContain('still brewing');
    expect(out).toContain('the build finished before this did');
    // The punchline is the LAST entry, not an earlier one.
    expect(text(entries.slice(0, -1))).not.toContain(
      'the build finished before this did',
    );
  });
});
