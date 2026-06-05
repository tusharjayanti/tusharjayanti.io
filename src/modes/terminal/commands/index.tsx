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
import hireMeBanner from '../banners/hire-me.txt?raw';
import dontHireMeBanner from '../banners/dont-hire-me.txt?raw';
import vaderArt from '../banners/vader.txt?raw';

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
  run: ({ args, append }) => {
    // Piped grep for "recruiter" (whoami | grep recruiter). Dispatch
    // splits the line on whitespace and does no shell parsing, so the
    // pipe and grep arrive as plain tokens. Sniff them directly; using
    // includes() rather than equality catches glued forms like `|grep`.
    const grepsRecruiter =
      args.some((a) => a.includes('grep')) &&
      args.some((a) => a.includes('recruiter'));
    if (grepsRecruiter) {
      playSequence(append, [
        { node: eggLine('scanning for recruiters...'), gap: 200 },
        { node: eggLine('match found.'), gap: 300 },
        {
          node: (
            <div className="term-block">
              <div className="term-line term-comment">
                matching "recruiter":
              </div>
              <div className="term-line">&nbsp;</div>
              <div className="term-line">
                Hi. Since you grepped for it, here's what I'd lead with:
              </div>
              <div className="term-line">&nbsp;</div>
              {[
                'Senior backend engineer, ~7 years, now building production AI systems.',
                'I ship real LLMOps, not demos. This site is the evidence.',
                "I communicate like someone you'd put in front of a customer.",
                'Bengaluru-based, open to senior AI/backend roles.',
              ].map((b, i) => (
                <div key={i} className="term-pitch-bullet">
                  <span className="term-arrow">→</span>
                  <span>{b}</span>
                </div>
              ))}
              <div className="term-line">&nbsp;</div>
              <div className="term-line">
                full pitch: type <span className="term-cmd">hire-me</span>
                {'   '}reach me:{' '}
                <span className="term-cmd">tj@tusharjayanti.io</span>
              </div>
            </div>
          ),
          gap: 320,
        },
      ]);
      return;
    }
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
          <div className="term-line">
            <span className="term-cmd">hire-me</span>
            <span className="term-dim"> the case for</span>
          </div>
          <div className="term-line">
            <span className="term-cmd">dont-hire-me</span>
            <span className="term-dim"> the case against</span>
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
      node: <pre className="term-history">{formatHistory(entries)}</pre>,
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

// Shared renderer for the hire-me / dont-hire-me pitch blocks. Each
// group is a colored tag chip, an optional dim caption, and a list of
// arrow bullets. Footer is free-form JSX (contact + cross-link).
type PitchGroup = {
  tag: string;
  variant: 'hire' | 'nope' | 'bonus';
  note?: string;
  bullets: string[];
};

// A horizontal lightsaber: dim hilt, glowing colored blade. 'jedi' is
// the green hire-me beam, 'dark' the red dont-hire-me beam.
function saber(variant: 'jedi' | 'dark'): ReactNode {
  return (
    <div className="term-saber">
      <span className="term-saber-hilt">▐█▌</span>
      <span className={`term-saber-${variant}`}>{'━'.repeat(42)}▸</span>
    </div>
  );
}

function renderPitch(
  banner: string,
  subtitle: string,
  flourish: ReactNode,
  groups: PitchGroup[],
  footer: ReactNode,
  intro?: ReactNode,
  dark?: boolean,
  postBanner?: ReactNode,
): ReactNode {
  return (
    <div className="term-block">
      <pre className={`term-banner${dark ? ' term-banner-dark' : ''}`}>
        {banner}
      </pre>
      {postBanner}
      {intro ? (
        <>
          {intro}
          <div className="term-line">&nbsp;</div>
        </>
      ) : null}
      <div className="term-line term-comment">{subtitle}</div>
      {flourish}
      <div className="term-line">&nbsp;</div>
      {groups.map((g, gi) => (
        <div key={gi} className="term-block">
          <div className="term-line">
            <span className={`term-tag term-tag-${g.variant}`}>{g.tag}</span>
          </div>
          {g.note
            ? g.note.split('\n').map((line, ni) => (
                <div key={ni} className="term-line term-comment">
                  {line}
                </div>
              ))
            : null}
          <div className="term-line">&nbsp;</div>
          {g.bullets.map((b, bi) => (
            <div key={bi} className="term-pitch-bullet">
              <span className="term-arrow">→</span>
              <span>{b}</span>
            </div>
          ))}
          <div className="term-line">&nbsp;</div>
        </div>
      ))}
      {footer}
    </div>
  );
}

const hireMe: Command = {
  name: 'hire-me',
  summary: 'the honest pitch',
  run: ({ append }) => {
    append({
      kind: 'output',
      node: renderPitch(
        hireMeBanner,
        '// the jedi side',
        saber('jedi'),
        [
          {
            tag: 'THE FORCE IS STRONG',
            variant: 'hire',
            bullets: [
              'I care deeply about how people experience the things I build, not just the people who pay for them.',
              "I'll raise the awkward question in the room. A minute now beats a week of postmortem later.",
              "I build for the load I have, with one eye on the load I'll have. I learned where that line sits the expensive way, not from a blog post.",
              'I reproduce the bug with a failing test before I touch the fix.',
              "When I think a call is wrong, you'll hear it. Directly, respectfully.",
              'I mentor. Best outcome: they ship it without me and I hear about it in standup.',
              'I say "I don\'t know" early and without flinching, then go find out. Pretending otherwise just delays the reckoning.',
            ],
          },
          {
            tag: 'JEDI MIND TRICKS',
            variant: 'bonus',
            note: "// the tiebreakers, if you're on the fence\n// you don't need to see other candidates",
            bullets: [
              "I'm an engineer who's also good with people. We exist. It's not a typo.",
              'I write the limitation down before anyone trips over it. The known bug goes in the README, not in my head.',
              "I name things so the version of me six months from now isn't cursing the version writing this.",
              "I'm a coffee nerd. Ask about espresso, cortados or pour-overs only if you have fifteen minutes you won't get back.",
              "I drum, so classic-rock references will sneak into standup. It's not a phase.",
            ],
          },
        ],
        <>
          <div className="term-line">
            Sound like your kind of hire?{' '}
            <span className="term-cmd">tj@tusharjayanti.io</span>
          </div>
          <div className="term-line term-comment">
            // or skip the pitch and just ask me something in the chat
          </div>
          <div className="term-line">&nbsp;</div>
          <div className="term-line term-comment">
            // every jedi has a dark side. run{' '}
            <span className="term-cmd">dont-hire-me</span> for mine.
          </div>
        </>,
      ),
    });
  },
};

const dontHireMe: Command = {
  name: 'dont-hire-me',
  summary: 'the other side',
  run: ({ append }) => {
    append({
      kind: 'output',
      node: renderPitch(
        dontHireMeBanner,
        '// the dark side',
        saber('dark'),
        [
          {
            tag: 'DARK SIDE TENDENCIES',
            variant: 'nope',
            bullets: [
              "If you want someone who just ships and never asks why, I'm the wrong guy.",
              "I ask a lot of questions when I'm ramping up. If you read that as slow, you'll miss the impact once I have the full context.",
              "I have opinions about architecture. I'll make my case passionately, then commit. Even to the call I argued against.",
              '"We\'ve always done it this way" is not a design doc.',
              "I won't give you the estimate you want to hear. You'll get the realistic one, even when it's inconvenient.",
              "I'll rename your `data2` on sight. Vague variable names cause me physical discomfort.",
            ],
          },
          {
            tag: 'SITH HABITS',
            variant: 'bonus',
            note: '// in everyone, a little dark side there is',
            bullets: [
              'I underestimate the last 10%. Every. Single. Time.',
              'I go deep on the interesting problem and resurface with a working thing and no memory of the hours.',
              'I find "done" genuinely hard to declare. There is always one more trace to add. ¯\\_(ツ)_/¯',
            ],
          },
        ],
        <>
          <div className="term-line">Read all that and still here?</div>
          <div className="term-line">
            <span className="term-cmd">tj@tusharjayanti.io</span>
          </div>
          <div className="term-line term-comment">
            // bold move. let's talk.
          </div>
        </>,
        <div className="term-line term-cmd">oh? a curious one, are we?</div>,
        true,
        <pre className="term-vader">{vaderArt}</pre>,
      ),
    });
  },
};

// Hidden easter eggs. None of these appear in `help` (it's a hand-written
// JSX block, not generated from the registry) so they stay discoverable
// only by typing. They must be registered here regardless, because
// Terminal.tsx routes any unknown first token to the chat backend.

// One-line gag with an optional dim aside, the terminal's `// ...` voice.
function quip(main: ReactNode, aside?: string): ReactNode {
  return (
    <div className="term-block">
      <div className="term-line">{main}</div>
      {aside ? <div className="term-line term-comment">{aside}</div> : null}
    </div>
  );
}

// One easter-egg line: plain status text, or a comment-styled aside.
function eggLine(content: string, comment = false): ReactNode {
  return (
    <div className={comment ? 'term-line term-comment' : 'term-line'}>
      {content}
    </div>
  );
}

// Reveal a sequence of nodes one at a time — presentation only. `gap` is the
// pause BEFORE each step in ms (~150-350 for a normal beat, ~600 for a
// comedic pause). Each step is just an append on a cumulative timer, so the
// lines land in order and the final punchline always arrives last.
function playSequence(
  append: (entry: ScrollbackEntry) => void,
  steps: ReadonlyArray<{ node: ReactNode; gap: number }>,
): void {
  let elapsed = 0;
  for (const step of steps) {
    elapsed += step.gap;
    setTimeout(() => append({ kind: 'output', node: step.node }), elapsed);
  }
}

const sudo: Command = {
  name: 'sudo',
  summary: 'elevate privileges',
  run: ({ append }) => {
    playSequence(append, [
      { node: eggLine('[sudo] verifying identity...'), gap: 200 },
      { node: eggLine('consulting the sudoers file...'), gap: 280 },
      { node: eggLine('escalating...'), gap: 280 },
      { node: eggLine('→ granted: elevated smart-ass permissions.'), gap: 320 },
      {
        node: eggLine(
          "(does nothing. but you feel powerful, and that's what matters.)",
          true,
        ),
        gap: 220,
      },
    ]);
  },
};

const rm: Command = {
  name: 'rm',
  summary: 'remove files',
  run: ({ args, append }) => {
    // -rf in any glued or split form (-rf, -fr, -Rf). Bare `rm` or any
    // args without the force flags fall through to the dare.
    const forced = args.some(
      (a) => a.startsWith('-') && /r/i.test(a) && /f/i.test(a),
    );
    if (!forced) {
      append({
        kind: 'output',
        node: quip('rm?', "// really? where's the -rf? go on, I dare you."),
      });
      return;
    }
    playSequence(append, [
      { node: eggLine('nuking everything Tushar ever built...'), gap: 220 },
      { node: eggLine('shortlist ... gone'), gap: 260 },
      { node: eggLine('vox-agent ... gone'), gap: 260 },
      { node: eggLine('tusharjayanti.io ... gon-'), gap: 260 },
      { node: eggLine('really? you think that works here?'), gap: 600 },
      {
        node: eggLine(
          "nothing was touched. I version-control my mistakes, I don't delete them.",
          true,
        ),
        gap: 320,
      },
    ]);
  },
};

const vim: Command = {
  name: 'vim',
  summary: 'text editor',
  run: ({ append }) => {
    playSequence(append, [
      { node: eggLine('opening vim...'), gap: 200 },
      { node: eggLine('loaded. 1 buffer. 0 idea how to leave.'), gap: 300 },
      { node: eggLine(':q ... nothing.'), gap: 260 },
      { node: eggLine(':q! ... nothing.'), gap: 260 },
      { node: eggLine('you live here now. we all do.', true), gap: 320 },
    ]);
  },
};

const emacs: Command = {
  name: 'emacs',
  summary: 'text editor',
  run: ({ append }) => {
    playSequence(append, [
      { node: eggLine('launching emacs...'), gap: 200 },
      { node: eggLine('loading mail client...'), gap: 250 },
      { node: eggLine('loading file manager...'), gap: 250 },
      { node: eggLine('loading psychotherapist (M-x doctor)...'), gap: 250 },
      { node: eggLine('loading a text editor... eventually.'), gap: 280 },
      {
        node: eggLine('ready. your pinky has already filed a complaint.', true),
        gap: 320,
      },
    ]);
  },
};

const coffeeCup = `    ( (
     ) )
  ........
  |      |]
  |      |
  '------'`;

const coffee: Command = {
  name: 'coffee',
  summary: 'brew a cup',
  run: ({ append }) => {
    playSequence(append, [
      { node: <pre className="term-egg">{coffeeCup}</pre>, gap: 150 },
      { node: eggLine('grinding beans...'), gap: 280 },
      { node: eggLine('brewing...'), gap: 280 },
      { node: eggLine('still brewing...'), gap: 350 },
      {
        node: eggLine('the build finished before this did. priorities.', true),
        gap: 320,
      },
    ]);
  },
};

const tushar: Command = {
  name: 'tushar',
  summary: 'the maintainer',
  run: ({ args, append }) => {
    if (args.includes('--version')) {
      playSequence(append, [
        { node: eggLine('resolving build metadata...'), gap: 220 },
        {
          node: (
            <div className="term-block">
              <div className="term-line">tushar 7.x (latest)</div>
              <div className="term-line">
                {'  '}
                <span className="term-status-shipped">+ added:</span> production
                AI systems
              </div>
              <div className="term-line">
                {'  '}
                <span className="term-status-shipped">+ improved:</span>{' '}
                explaining things to people who don't write code
              </div>
              <div className="term-line">
                {'  '}
                <span className="term-error">- removed:</span> the reflex to say
                yes to everything
              </div>
              <div className="term-line">
                {'  '}
                <span className="term-status-in-progress">wontfix:</span> still
                cannot mark anything "done"
              </div>
            </div>
          ),
          gap: 320,
        },
      ]);
      return;
    }
    append({
      kind: 'output',
      node: quip("that's me.", "// type 'tushar --version' for the changelog."),
    });
  },
};

const trainArt = `      ====        ________
  _D _|  |_______/        |__
 |(_)---  |   H\\________/ |  |
  O-O--O-O   'O-O'   O-O--O-O`;

const sl: Command = {
  name: 'sl',
  summary: 'steam locomotive',
  run: ({ append }) => {
    append({
      kind: 'output',
      node: (
        <div className="term-block">
          <pre className="term-egg">{trainArt}</pre>
          <div className="term-line term-comment">
            // you meant ls. enjoy the ride.
          </div>
        </div>
      ),
    });
  },
};

const man: Command = {
  name: 'man',
  summary: 'manual pages',
  run: ({ args, append }) => {
    if (args.length === 0) {
      append({ kind: 'output', node: quip('What manual page do you want?') });
      return;
    }
    append({
      kind: 'output',
      node: quip(
        `no manual entry for ${args[0]}.`,
        '// have you tried reading the source? I have.',
      ),
    });
  },
};

const fortyTwo: Command = {
  name: '42',
  summary: 'the answer',
  run: ({ append }) => {
    playSequence(append, [
      { node: eggLine('computing the answer...'), gap: 200 },
      {
        node: eggLine('(estimated time remaining: 7.5 million years)', true),
        gap: 300,
      },
      { node: eggLine('...'), gap: 300 },
      { node: eggLine('42. now what was the question?'), gap: 600 },
    ]);
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
  'hire-me': hireMe,
  'dont-hire-me': dontHireMe,
  sudo,
  rm,
  vim,
  emacs,
  coffee,
  tushar,
  sl,
  man,
  '42': fortyTwo,
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
