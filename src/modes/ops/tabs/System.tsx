// System tab — current prompt version, this-hour rate-limit counters,
// free-tier headroom, and provider/region facts.

import { useOpsApi } from '../../../lib/opsApi';

interface HeadroomBar {
  key: string;
  label: string;
  used: number;
  cap: number;
  cap_label: string;
  pct: number;
}
interface SystemData {
  prompt: {
    name: string;
    version: number;
    hash: string;
    canary_prefix: string;
    labels: string[] | null;
    updated_at: string | null;
  };
  rate_limits: {
    window: string;
    requests: number;
    distinct_ips: number;
    at_cap: number;
    per_ip_cap: number;
  };
  headroom: HeadroomBar[];
  providers: { name: string; region: string; plan: string }[];
}

export function System({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { data, loading, error } = useOpsApi<SystemData>({
    url: '/api/ops/system',
    onUnauthorized,
  });

  if (error)
    return (
      <div className="ops-panel ops-error">system unavailable — {error}</div>
    );
  if (!data)
    return (
      <div className="ops-panel ops-muted">{loading ? 'loading…' : '—'}</div>
    );

  const p = data.prompt;
  const rl = data.rate_limits;

  return (
    <div className="ops-overview">
      <div className="ops-grid-2">
        <section className="ops-panel">
          <h3 className="ops-panel-title">system prompt</h3>
          <div className="ops-panel-sub">{p.name}</div>
          <dl className="ops-kv">
            <dt>version</dt>
            <dd>v{p.version}</dd>
            <dt>hash</dt>
            <dd className="ops-mono">{p.hash}</dd>
            <dt>canary</dt>
            <dd className="ops-mono">{p.canary_prefix}</dd>
            <dt>labels</dt>
            <dd>{p.labels?.length ? p.labels.join(', ') : '—'}</dd>
            <dt>updated</dt>
            <dd>
              {p.updated_at ? p.updated_at.slice(0, 16).replace('T', ' ') : '—'}
            </dd>
          </dl>
        </section>

        <section className="ops-panel">
          <h3 className="ops-panel-title">rate limits (this hour)</h3>
          <div className="ops-panel-sub">
            window {rl.window} · cap {rl.per_ip_cap}/ip/hr
          </div>
          <div className="ops-kpis ops-kpis--3">
            <Kpi label="requests" value={String(rl.requests)} />
            <Kpi label="distinct ips" value={String(rl.distinct_ips)} />
            <Kpi label="at cap" value={String(rl.at_cap)} />
          </div>
        </section>
      </div>

      <section className="ops-panel">
        <h3 className="ops-panel-title">free-tier headroom</h3>
        <div className="ops-panel-sub">
          measured usage vs documented free-tier caps
        </div>
        {data.headroom.map((h) => (
          <div className="ops-headroom-row" key={h.key}>
            <span className="ops-headroom-label">{h.label}</span>
            <span className="ops-headroom-track">
              <span
                className="ops-headroom-fill"
                style={{
                  width: `${h.pct}%`,
                  background:
                    h.pct > 80 ? 'var(--ctp-red)' : 'var(--ctp-mauve)',
                }}
              />
            </span>
            <span className="ops-headroom-val">
              {h.used.toLocaleString()} / {h.cap_label} · {h.pct}%
            </span>
          </div>
        ))}
      </section>

      <section className="ops-panel">
        <h3 className="ops-panel-title">providers</h3>
        <table className="ops-table">
          <tbody>
            {data.providers.map((pr) => (
              <tr key={pr.name}>
                <td>{pr.name}</td>
                <td className="ops-muted">{pr.region}</td>
                <td>{pr.plan}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-value">{value}</div>
      <div className="ops-kpi-label">{label}</div>
    </div>
  );
}
