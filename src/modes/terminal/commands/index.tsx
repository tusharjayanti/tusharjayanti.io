import type { ReactNode } from 'react';
import {
  allCatTargets,
  experienceSlugs,
  projectSlugs,
  renderSection,
  renderRole,
  renderProject,
  resolveCatTarget,
  sections,
} from './fileSystem';
import { whoami as whoamiText } from '../../../content/bio';
import { experience } from '../../../content/experience';
import { projects } from '../../../content/projects';
import { version } from '../../../../package.json';

export type ScrollbackEntry =
  | { kind: 'command'; text: string }
  | { kind: 'output'; node: ReactNode }
  | { kind: 'comment'; node: ReactNode }
  | { kind: 'error'; text: string }
  | {
      kind: 'chat-streaming';
      id: string;
      text: string;
      done: boolean;
      isError: boolean;
    };

export type CommandContext = {
  args: string[];
  raw: string;
  append: (entry: ScrollbackEntry) => void;
  updateById: (
    id: string,
    updater: (entry: ScrollbackEntry) => ScrollbackEntry,
  ) => void;
  clear: () => void;
  startedAt: number;
  chatSignal: AbortSignal;
  // User-typed command history for the current session. Excludes the
  // autoplay `whoami` (Terminal.tsx calls dispatch with
  // addToHistory:false for autoplay). The `history` command reads
  // this array; `clearHistory` resets it for the `history -c` flag.
  history: string[];
  clearHistory: () => void;
};

export type Command = {
  name: string;
  summary: string;
  run: (ctx: CommandContext) => void;
};

const whoami: Command = {
  name: 'whoami',
  summary: 'short bio',
  run: ({ append }) => {
    const paragraphs = whoamiText.split('\n\n');
    append({
      kind: 'output',
      node: (
        <div className="term-block">
          {paragraphs.flatMap((para, i) =>
            i < paragraphs.length - 1
              ? [
                  <div key={i} className="term-line">
                    {para}
                  </div>,
                  <div key={`b${i}`} className="term-line">
                    &nbsp;
                  </div>,
                ]
              : [
                  <div key={i} className="term-line">
                    {para}
                  </div>,
                ],
          )}
        </div>
      ),
    });
  },
};

const ls: Command = {
  name: 'ls',
  summary: 'list available files',
  run: ({ args, append }) => {
    if (args.length === 0) {
      append({
        kind: 'output',
        node: (
          <div className="term-ls">
            {sections.map((s) => (
              <span key={s}>
                {s === 'experience' || s === 'projects' ? `${s}/` : s}
              </span>
            ))}
          </div>
        ),
      });
      return;
    }
    const target = args[0];
    if (target === 'experience') {
      append({
        kind: 'output',
        node: (
          <div className="term-ls">
            {experienceSlugs().map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ),
      });
      return;
    }
    if (target === 'projects') {
      append({
        kind: 'output',
        node: (
          <div className="term-ls">
            {projectSlugs().map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ),
      });
      return;
    }
    append({
      kind: 'error',
      text: `ls: ¯\\_(ツ)_/¯ I don't see anything called ${target}`,
    });
  },
};

const cat: Command = {
  name: 'cat',
  summary: 'print a file',
  run: ({ args, append }) => {
    if (args.length === 0) {
      append({ kind: 'error', text: 'usage: cat <file>' });
      return;
    }
    const target = args[0];
    const resolved = resolveCatTarget(target);
    switch (resolved.kind) {
      case 'section':
        append({ kind: 'output', node: renderSection(resolved.key) });
        return;
      case 'role':
        append({ kind: 'output', node: renderRole(resolved.role) });
        return;
      case 'project':
        append({ kind: 'output', node: renderProject(resolved.project) });
        return;
      case 'not-found':
        append({
          kind: 'error',
          text: `cat: ¯\\_(ツ)_/¯ I don't see anything called ${target}`,
        });
    }
  },
};

const help: Command = {
  name: 'help',
  summary: 'this',
  run: ({ append }) => {
    append({
      kind: 'output',
      node: (
        <div className="term-block">
          <div className="term-line">Commands:</div>
          <div className="term-line">
            <span className="term-cmd">whoami</span>
            <span className="term-dim"> show identity</span>
          </div>
          <div className="term-line">
            <span className="term-cmd">ls &lt;dir&gt;</span>
            <span className="term-dim">
              {' '}
              list bio experience/ projects/ skills contact
            </span>
          </div>
          <div className="term-line">
            <span className="term-cmd">cat &lt;thing&gt;</span>
            <span className="term-dim">
              {' '}
              print a section (bio skills contact) or item (cat disco cat
              vox-agent)
            </span>
          </div>
          <div className="term-line">
            <span className="term-cmd">help</span>
            <span className="term-dim"> this message</span>
          </div>
          <div className="term-line">
            <span className="term-cmd">clear</span>
            <span className="term-dim"> clear the screen</span>
          </div>
          <div className="term-line">
            <span className="term-cmd">status</span>
            <span className="term-dim"> current status</span>
          </div>
          <div className="term-line">
            <span className="term-cmd">history</span>
            <span className="term-dim">
              {' '}
              show this session's commands; <code>history -c</code> clears
            </span>
          </div>
          <div className="term-line">&nbsp;</div>
          <div className="term-line">
            for anything else, just ask. I am trained well, and can answer
            Tushar-ish!
          </div>
          <div className="term-line">&nbsp;</div>
          <div className="term-line term-comment"># examples:</div>
          <div className="term-line term-comment">
            # what did you do at DISCO?
          </div>
          <div className="term-line term-comment">
            # tell me about vox-agent
          </div>
          <div className="term-line term-comment">
            # are you available for senior roles?
          </div>
        </div>
      ),
    });
  },
};

const clear: Command = {
  name: 'clear',
  summary: 'clear the screen',
  run: ({ clear: doClear }) => {
    doClear();
  },
};

// bash-style right-aligned numbering: a 4-char field padded with
// spaces, two spaces, then the command. Numbers don't reset when the
// scrollback is cleared — same as bash, where `clear` clears the
// screen but not the history list.
export function formatHistory(entries: string[]): string {
  return entries
    .map((cmd, i) => `${String(i + 1).padStart(4, ' ')}  ${cmd}`)
    .join('\n');
}

const history: Command = {
  name: 'history',
  summary: 'show session command history',
  run: ({ args, history: entries, append, clearHistory }) => {
    if (args[0] === '-c') {
      // Silent like bash. Subsequent `history` shows just that next
      // command, since `history -c` itself was added to the array
      // before this `run` fired and the clear wipes everything
      // including itself.
      clearHistory();
      return;
    }
    append({
      kind: 'output',
      node: (
        <pre className="term-history">{formatHistory(entries)}</pre>
      ),
    });
  },
};

const status: Command = {
  name: 'status',
  summary: 'system info',
  run: ({ append, startedAt }) => {
    const uptimeSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    append({
      kind: 'output',
      node: (
        <div className="term-block">
          <div className="term-line">
            <span className="term-dim">status:</span> ok
          </div>
          <div className="term-line">
            <span className="term-dim">build:</span>
            {'  '}v{version}
          </div>
          <div className="term-line">
            <span className="term-dim">chat:</span>
            {'   '}claude-sonnet-4-6
            <span className="term-comment">{'  '}# wired in chunk 5</span>
          </div>
          <div className="term-line">
            <span className="term-dim">uptime:</span> {uptimeSec}s
          </div>
        </div>
      ),
    });
  },
};

export const commands: Record<string, Command> = {
  whoami,
  ls,
  cat,
  help,
  clear,
  status,
  history,
};

export const commandNames = Object.keys(commands);

export function completeToken(prefix: string, candidates: string[]): string[] {
  return candidates.filter((c) => c.startsWith(prefix));
}

export function tabComplete(input: string): {
  next: string;
  suggestions: string[];
} {
  const tokens = input.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(input);

  if (tokens.length === 0) {
    return { next: input, suggestions: [] };
  }

  // Completing first token (command name)
  if (tokens.length === 1 && !endsWithSpace) {
    const matches = completeToken(tokens[0], commandNames);
    if (matches.length === 1) return { next: matches[0], suggestions: [] };
    if (matches.length > 1) {
      return { next: commonPrefix(matches), suggestions: matches };
    }
    return { next: input, suggestions: [] };
  }

  // Completing second token for cat / ls
  const cmd = tokens[0];
  const partial = endsWithSpace ? '' : tokens[tokens.length - 1];
  let candidates: string[] = [];
  if (cmd === 'cat') candidates = allCatTargets();
  else if (cmd === 'ls') candidates = ['experience', 'projects'];

  if (candidates.length === 0) return { next: input, suggestions: [] };

  const matches = completeToken(partial, candidates);
  if (matches.length === 0) return { next: input, suggestions: [] };

  const base = endsWithSpace
    ? input
    : input.slice(0, input.length - partial.length);

  if (matches.length === 1) {
    return { next: base + matches[0], suggestions: [] };
  }
  return { next: base + commonPrefix(matches), suggestions: matches };
}

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

// helpers re-exported for convenience
export { experience, projects };
