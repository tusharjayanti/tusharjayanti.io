import { useEffect, useState } from 'react';
import { useIsMobile } from '../lib/viewMode';
import {
  type OpsSnippet as Snippet,
  buildOpsView,
  isPopulated,
} from '../lib/opsSnippet';

// Terminal-themed observability widget shown top-right on the
// terminal/cv pages, stacked under the mode toggle. Pulls from
// /api/ops-snippet which itself caches the aggregation in Redis on
// a 5-minute freshness window — the fetch here is cheap.
//
// Suppression contract: when the snippet isn't populated (fetch
// failed, offline sentinel returned, all metrics zero, or no
// last_aggregated_at), the outer `.ops-snippet-container` still
// renders — its min-height reserves the HUD's vertical slot from
// first paint so the top-right-stack doesn't grow downward when
// data arrives. The inner styled box (border, background, lines)
// only mounts when populated. No placeholder, no skeleton — the
// reserved slot is invisible.
//
// Reveal animation: when the snippet IS populated, the inner box
// renders once without the `--populated` modifier (lines start at
// opacity: 0 via the base CSS rule), then on the next animation
// frame flip `populated = true` so the modifier class fires the
// staggered fade-up transition. CSS transitions need a "from"
// state to play against — rendering with the class already applied
// would skip the animation. Single rAF after first paint is the
// cheapest hook to guarantee that two-state sequence.

export function OpsSnippet() {
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [populated, setPopulated] = useState(false);
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

  // Two-frame dance so the CSS transition has a "from" state.
  // requestAnimationFrame defers `populated = true` past the first
  // paint of the lines (which render with opacity: 0 from the base
  // rule). The class flip on the next frame triggers the staggered
  // fade-up.
  const ready = isPopulated(snippet);
  useEffect(() => {
    if (!ready) return;
    if (populated) return;
    const id = requestAnimationFrame(() => setPopulated(true));
    return () => cancelAnimationFrame(id);
  }, [ready, populated]);

  // Outer container is ALWAYS rendered. Its `min-height` (set per
  // viewport in CSS) reserves the HUD's vertical slot from first
  // paint so the top-right-stack doesn't grow downward when the
  // inner styled box appears. The container itself has no visible
  // styling — only the inner `.ops-snippet` box (rendered when
  // `ready`) has border/background. Layout stable, content
  // suppressed-then-revealed.
  const view = ready ? buildOpsView(snippet) : null;
  const populatedClass = populated ? ' ops-snippet--populated' : '';

  return (
    <div
      className="ops-snippet-container"
      aria-label="Site observability snippet"
    >
      {ready && view && isMobile && (
        <div className={`ops-snippet ops-snippet--mobile${populatedClass}`}>
          {view.mobile}
        </div>
      )}
      {ready && view && !isMobile && (
        <div className={`ops-snippet${populatedClass}`}>
          <div className="ops-snippet-title">ops/</div>
          {view.rows.map((row) => (
            <div key={row.label} className="ops-snippet-row">
              <span className="ops-snippet-label">{row.label}</span>
              <span className="ops-snippet-value">{row.value}</span>
            </div>
          ))}
          <div className="ops-snippet-footer">{view.footer}</div>
        </div>
      )}
    </div>
  );
}
