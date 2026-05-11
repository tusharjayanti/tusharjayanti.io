import {
  forwardRef,
  type KeyboardEvent,
  type ChangeEvent,
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

export const Prompt = forwardRef<HTMLInputElement, PromptProps>(
  function Prompt(
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
    ref,
  ) {
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

    return (
      <div className="term-prompt-row">
        <PromptPrefix />
        <span className="term-prompt-content">
          <span className="term-prompt-text">{value}</span>
          {showCursor && <span className="term-cursor" aria-hidden />}
          <input
            ref={ref}
            className="term-prompt-input"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
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
  },
);
