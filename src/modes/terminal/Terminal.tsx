import { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../../lib/viewMode';
import { Prompt, PromptPrefix } from './Prompt';
import { commands, tabComplete, type ScrollbackEntry } from './commands';
import { runChat } from './commands/chat';

const TYPING_DELAY_MS = 80;
const POST_TYPING_PAUSE_MS = 200;
const AUTOPLAY_TARGET = 'whoami';

function Hint() {
  return (
    <span className="term-comment">
      # `<code className="term-comment-key">help</code>` for commands. for
      everything else, ask Tarvis: i'm Jarvis to Tushar's slightly-less-Stark
      engineering.
    </span>
  );
}

function MobileHint() {
  return <span className="term-comment"># tap to explore:</span>;
}

const mobileChips = ['help', 'ls experience', 'ls projects'] as const;

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
  const chatAbortRef = useRef<AbortController | null>(null);

  function append(entry: ScrollbackEntry) {
    setScrollback((prev) => [...prev, entry]);
  }

  function clearScrollback() {
    setScrollback([]);
  }

  function updateById(
    id: string,
    updater: (entry: ScrollbackEntry) => ScrollbackEntry,
  ): void {
    setScrollback((prev) => {
      const idx = prev.findIndex(
        (e) => e.kind === 'chat-streaming' && e.id === id,
      );
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = updater(next[idx]);
      return next;
    });
  }

  function dispatch(
    raw: string,
    opts: { addToHistory: boolean; chatSignal?: AbortSignal } = {
      addToHistory: true,
    },
  ) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    append({ kind: 'command', text: trimmed });
    // Compute the post-dispatch history synchronously so the `history`
    // command sees its own invocation at the bottom of the list (bash
    // semantics). setHistory is async; passing the closure-captured
    // `history` value into the command context would be one step stale.
    let nextHistory = history;
    if (opts.addToHistory) {
      nextHistory = [...history, trimmed];
      setHistory(nextHistory);
    }
    // Known commands ignore chatSignal; for the chat fallback we need a real
    // signal. Callers that omit it (autoplay's whoami, mobile chip taps) get a
    // throwaway controller that never aborts.
    const signal = opts.chatSignal ?? new AbortController().signal;
    const [name, ...args] = trimmed.split(/\s+/);
    const cmd = commands[name];
    if (cmd) {
      cmd.run({
        args,
        raw: trimmed,
        append,
        updateById,
        clear: clearScrollback,
        startedAt: startedAtRef.current,
        chatSignal: signal,
        history: nextHistory,
        clearHistory: () => setHistory([]),
      });
      return;
    }
    // Not a known command — route the whole input to the chat backend.
    void runChat(trimmed, append, updateById, signal);
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

  // Refocus when autoplay finishes — queueMicrotask defers past React's
  // commit phase so the input is settled in the DOM before .focus() runs.
  useEffect(() => {
    if (autoplayDone) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [autoplayDone]);

  // Tab visibility change — restore focus when the page comes back.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        inputRef.current?.focus();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Document-level click listener — keeps the input focused regardless of
  // where the user clicks on the /terminal page (wordmark, tagline, footer,
  // blank space). Interactive elements still get their click first (mode
  // toggle, privacy link); this listener just ensures focus returns to the
  // input afterward. Active text selection is preserved (no refocus while
  // the user is highlighting for copy).
  useEffect(() => {
    if (isMobile) return; // mobile uses chips, no input to focus
    if (!autoplayDone) return; // input doesn't exist during autoplay

    function onDocumentClick() {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      inputRef.current?.focus();
    }

    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [autoplayDone, isMobile]);

  // Scroll to bottom on scrollback change
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [scrollback.length]);

  // Abort any in-flight chat stream when Terminal unmounts.
  useEffect(() => {
    return () => {
      if (chatAbortRef.current) {
        chatAbortRef.current.abort();
        chatAbortRef.current = null;
      }
    };
  }, []);

  function handleSubmit(v: string) {
    if (!autoplayDone) return;
    // Abort any in-flight chat from a previous command.
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    // Fresh controller for this dispatch (used only if it routes to chat).
    const controller = new AbortController();
    chatAbortRef.current = controller;
    setInput('');
    setHistoryIndex(-1);
    dispatch(v, { addToHistory: true, chatSignal: controller.signal });
    // Explicit refocus after submit — queueMicrotask defers until after
    // React's commit so the input element is settled.
    queueMicrotask(() => inputRef.current?.focus());
  }

  function handleHistoryPrev() {
    if (history.length === 0) return;
    const next =
      historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
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
            case 'chat-streaming': {
              const isLoader = !entry.done && entry.text.length === 0;
              const containerClass = entry.isError
                ? 'term-chat-streaming term-comment'
                : 'term-chat-streaming';
              return (
                <div key={i} className={containerClass}>
                  {isLoader ? (
                    <span>
                      <span className="term-cursor" aria-hidden />
                      <span className="term-dim"> thinking</span>
                    </span>
                  ) : (
                    <>
                      <span>{entry.text}</span>
                      {!entry.done && (
                        <span className="term-cursor" aria-hidden />
                      )}
                    </>
                  )}
                </div>
              );
            }
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
