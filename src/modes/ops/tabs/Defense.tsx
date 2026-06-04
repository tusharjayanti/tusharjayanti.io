// Defense tab — guardrail funnel + defense-tag counts + recent events.

import { useOpsApi } from '../../../lib/opsApi';

interface DefenseData {
  funnel: { stage: string; count: number }[];
  tag_counts: Record<string, number>;
  recent_events: {
    id: string;
    ts: string;
    kind: 'injection' | 'canary-leak';
    preview_q: string;
  }[];
}

interface Props {
  windowDays: number;
  includeEvals: boolean;
  onUnauthorized: () => void;
}

const fmtTime = (iso: string) => iso.slice(5, 16).replace('T', ' ');

export function Defense({ windowDays, includeEvals, onUnauthorized }: Props) {
  const { data, loading, error } = useOpsApi<DefenseData>({
    url: '/api/ops/defense',
    params: { windowDays, includeEvals },
    onUnauthorized,
  });

  if (error)
    return (
      <div className="ops-panel ops-error">defense unavailable — {error}</div>
    );
  if (!data)
    return (
      <div className="ops-panel ops-muted">{loading ? 'loading…' : '—'}</div>
    );

  const top = data.funnel[0]?.count ?? 0;

  return (
    <div className="ops-overview">
      <section className="ops-panel">
        <h3 className="ops-panel-title">guardrail funnel</h3>
        <div className="ops-panel-sub">
          {top} requests · {windowDays}d
        </div>
        <div className="ops-funnel">
          {data.funnel.map((s) => {
            const w = top === 0 ? 0 : (s.count / top) * 100;
            return (
              <div className="ops-funnel-row" key={s.stage}>
                <span className="ops-funnel-label">{s.stage}</span>
                <span className="ops-funnel-track">
                  <span
                    className="ops-funnel-fill"
                    style={{ width: `${w}%` }}
                  />
                </span>
                <span className="ops-funnel-count">{s.count}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="ops-grid-2">
        <section className="ops-panel">
          <h3 className="ops-panel-title">defense-tag counts</h3>
          <div className="ops-tagcounts">
            {Object.entries(data.tag_counts).map(([tag, n]) => (
              <div className="ops-tagcount" key={tag}>
                <span className="ops-tagcount-n">{n}</span>
                <span className="ops-tagcount-tag">{tag}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ops-panel">
          <h3 className="ops-panel-title">recent events</h3>
          <div className="ops-panel-sub">injection + canary, newest first</div>
          {data.recent_events.length === 0 ? (
            <div className="ops-muted">none in window</div>
          ) : (
            <ul className="ops-events">
              {data.recent_events.map((e) => (
                <li className="ops-event" key={`${e.id}-${e.kind}`}>
                  <span
                    className={`ops-pill ${
                      e.kind === 'canary-leak' ? 'ops-pill--r' : 'ops-pill--p'
                    }`}
                  >
                    {e.kind}
                  </span>
                  <span className="ops-event-time">{fmtTime(e.ts)}</span>
                  <span className="ops-event-q">
                    {e.preview_q || '(no input)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
