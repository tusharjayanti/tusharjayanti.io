import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';

export function PromptPrefix() {
  return (
    <span className="term-prompt-prefix">
      <span className="term-prompt-user">tushar</span>
      <span className="term-prompt-at">@</span>
      <span className="term-prompt-host">bengaluru</span>
      <span className="term-prompt-colon">:</span>
      <span className="term-prompt-path">~</span>
      <span className="term-prompt-dollar">$</span>
    </span>
  );
}

type PromptProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  onTab: () => void;
  readOnly?: boolean;
  showCursor?: boolean;
};

export const Prompt = forwardRef<HTMLInputElement, PromptProps>(function Prompt(
  {
    value,
    onChange,
    onSubmit,
    onHistoryPrev,
    onHistoryNext,
    onTab,
    readOnly = false,
    showCursor = true,
  },
  externalRef,
) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const [cursorPosition, setCursorPosition] = useState(value.length);

  // Merge external forwarded ref + internal ref so we can read
  // selectionStart while still letting Terminal call .focus() on the input.
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      localRef.current = node;
      if (typeof externalRef === 'function') externalRef(node);
      else if (externalRef) externalRef.current = node;
    },
    [externalRef],
  );

  // Sync cursor on every `value` change (covers programmatic setInput from
  // history nav / tab completion). When focused, use the real selectionStart;
  // otherwise jump to end-of-value (matches browser default).
  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    if (document.activeElement === el && el.selectionStart != null) {
      setCursorPosition(el.selectionStart);
    } else {
      setCursorPosition(value.length);
    }
  }, [value]);

  const updateCursor = useCallback((e: SyntheticEvent<HTMLInputElement>) => {
    const pos = e.currentTarget.selectionStart;
    if (pos != null) setCursorPosition(pos);
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit(value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onHistoryPrev();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onHistoryNext();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onTab();
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    onChange(e.target.value);
  }

  const before = value.slice(0, cursorPosition);
  const after = value.slice(cursorPosition);

  return (
    <div className="term-prompt-row">
      <PromptPrefix />
      <span className="term-prompt-content">
        <span className="term-prompt-text">{before}</span>
        {showCursor && <span className="term-cursor" aria-hidden />}
        <span className="term-prompt-text">{after}</span>
        <input
          ref={setRefs}
          className="term-prompt-input"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
          onInput={updateCursor}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="terminal input"
          readOnly={readOnly}
        />
      </span>
    </div>
  );
});
