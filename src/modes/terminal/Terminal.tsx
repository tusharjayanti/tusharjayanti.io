import { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../../lib/viewMode';
import { Prompt, PromptPrefix } from './Prompt';
import {
  commands,
  tabComplete,
  type ScrollbackEntry,
} from './commands';

const TYPING_DELAY_MS = 45;
const POST_TYPING_PAUSE_MS = 200;
const AUTOPLAY_TARGET = 'whoami';

function Hint() {
  return (
    <span className="term-comment">
      // <code className="term-comment-key">help</code> for the menu.{' '}
      <code className="term-comment-key">ask &lt;your question&gt;</code> to
      chat with me.
    </span>
  );
}

function MobileHint() {
  return <span className="term-comment">// tap to explore:</span>;
}

const mobileChips = ['help', 'ls experience', 'ls projects', 'ask'] as const;

export function Terminal() {
  const isMobile = useIsMobile();
  const [scrollback, setScrollback] = useState<ScrollbackEntry[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [autoplayText, setAutoplayText] = useState('');
  const [autoplayDone, setAutoplayDone] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const startedAtRef = useRef<number>(Date.now());

  function append(entry: ScrollbackEntry) {
    setScrollback((prev) => [...prev, entry]);
  }

  function clearScrollback() {
    setScrollback([]);
  }

  function dispatch(raw: string, opts: { addToHistory: boolean } = { addToHistory: true }) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    append({ kind: 'command', text: trimmed });
    if (opts.addToHistory) {
      setHistory((prev) => [...prev, trimmed]);
    }
    const [name, ...args] = trimmed.split(/\s+/);
    const cmd = commands[name];
    if (!cmd) {
      append({ kind: 'error', text: `command not found: ${name}` });
      return;
    }
    cmd.run({
      args,
      raw: trimmed,
      append,
      clear: clearScrollback,
      startedAt: startedAtRef.current,
    });
  }

  // Autoplay: type one char per interval tick, then pause, then submit.
  // setInterval (not nested setTimeouts / async) so each tick is its own
  // task — React paints between setStates, no batching, no closure race.
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    setAutoplayText('');

    const typeInterval = setInterval(() => {
      if (cancelled) return;
      i += 1;
      setAutoplayText(AUTOPLAY_TARGET.slice(0, i));
      if (i >= AUTOPLAY_TARGET.length) {
        clearInterval(typeInterval);
        setTimeout(() => {
          if (cancelled) return;
          dispatch(AUTOPLAY_TARGET, { addToHistory: false });
          append({
            kind: 'comment',
            node: isMobile ? <MobileHint /> : <Hint />,
          });
          setAutoplayDone(true);
        }, POST_TYPING_PAUSE_MS);
      }
    }, TYPING_DELAY_MS);

    return () => {
      cancelled = true;
      clearInterval(typeInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus input when autoplay completes / scrollback updates
  useEffect(() => {
    if (autoplayDone && !isMobile) {
      inputRef.current?.focus();
    }
  }, [autoplayDone, scrollback.length, isMobile]);

  // Scroll to bottom on scrollback change
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [scrollback.length]);

  function handleSubmit(v: string) {
    if (!autoplayDone) return;
    setInput('');
    setHistoryIndex(-1);
    dispatch(v);
  }

  function handleHistoryPrev() {
    if (history.length === 0) return;
    const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(next);
    setInput(history[next]);
  }

  function handleHistoryNext() {
    if (historyIndex < 0) return;
    const next = historyIndex + 1;
    if (next >= history.length) {
      setHistoryIndex(-1);
      setInput('');
      return;
    }
    setHistoryIndex(next);
    setInput(history[next]);
  }

  function handleTab() {
    const { next, suggestions } = tabComplete(input);
    if (suggestions.length > 0) {
      append({
        kind: 'output',
        node: (
          <div className="term-ls">
            {suggestions.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ),
      });
    }
    if (next !== input) setInput(next);
  }

  function handleChipTap(label: string) {
    if (!autoplayDone) return;
    dispatch(label);
  }

  return (
    <div className="terminal">
      <div ref={scrollRef} className="term-scrollback">
        {scrollback.map((entry, i) => {
          switch (entry.kind) {
            case 'command':
              return (
                <div key={i} className="term-line term-command-line">
                  <PromptPrefix />
                  <span>{entry.text}</span>
                </div>
              );
            case 'output':
              return (
                <div key={i} className="term-output">
                  {entry.node}
                </div>
              );
            case 'comment':
              return (
                <div key={i} className="term-line">
                  {entry.node}
                </div>
              );
            case 'error':
              return (
                <div key={i} className="term-line term-error">
                  {entry.text}
                </div>
              );
          }
        })}
      </div>

      {/* Autoplay: typed-character row. autoplayText only, no input. */}
      {!autoplayDone && (
        <div className="term-autoplay-row">
          <PromptPrefix />
          <span className="term-autoplay-text">{autoplayText}</span>
          <span className="term-cursor" aria-hidden />
        </div>
      )}

      {/* Mobile post-autoplay: tap chips only, no typing input. */}
      {autoplayDone && isMobile && (
        <div className="term-chips">
          {mobileChips.map((label) => (
            <button
              key={label}
              className="term-chip"
              onClick={() => handleChipTap(label)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Desktop post-autoplay: live Prompt component. */}
      {autoplayDone && !isMobile && (
        <Prompt
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onHistoryPrev={handleHistoryPrev}
          onHistoryNext={handleHistoryNext}
          onTab={handleTab}
          readOnly={false}
          showCursor
        />
      )}
    </div>
  );
}
