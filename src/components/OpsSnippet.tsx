import { useEffect, useState } from 'react';
import { useIsMobile } from '../lib/viewMode';
import { type OpsSnippet as Snippet, buildOpsView } from '../lib/opsSnippet';

// Terminal-themed observability widget shown top-right on the
// terminal/cv pages, stacked under the mode toggle. Pulls from
// /api/ops-snippet which itself caches the aggregation in Redis on
// a 5-minute freshness window — the fetch here is cheap.
//
// Failure mode is silent: any fetch error / malformed JSON downgrades
// to the offline state. Widget never throws, never blocks render.

export function OpsSnippet() {
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/ops-snippet', { signal: ac.signal });
        if (!res.ok) {
          if (!cancelled) setSnippet(null);
          return;
        }
        const data = (await res.json()) as Snippet;
        if (!cancelled) setSnippet(data);
      } catch (err) {
        if (cancelled) return;
        if ((err as Error)?.name === 'AbortError') return;
        // Network error / JSON parse failure / etc. — fall through
        // to the offline state. Widget never blocks page render.
        console.warn('[ops] snippet fetch failed:', err);
        setSnippet(null);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  const view = buildOpsView(snippet);

  if (isMobile) {
    return (
      <div
        className={`ops-snippet ops-snippet--mobile${
          view.is_offline ? ' ops-snippet--offline' : ''
        }`}
        aria-label="Site observability snippet"
      >
        {view.mobile}
      </div>
    );
  }

  return (
    <div
      className={`ops-snippet${view.is_offline ? ' ops-snippet--offline' : ''}`}
      aria-label="Site observability snippet"
    >
      <div className="ops-snippet-title">ops/</div>
      {view.rows.map((row) => (
        <div key={row.label} className="ops-snippet-row">
          <span className="ops-snippet-label">{row.label}</span>
          <span className="ops-snippet-value">{row.value}</span>
        </div>
      ))}
      <div className="ops-snippet-footer">{view.footer}</div>
    </div>
  );
}
