// Overview tab — the vertical slice against /api/ops/stats. KPI row plus
// cost-by-model, latency-by-step, and conversations/day panels. Metrics
// that belong to other tabs' endpoints (eval pass-rate → Evals/D3,
// injections → Defense/D2) render as "—" rather than fabricated numbers.

import { useOpsApi, type StatsData } from '../../../lib/opsApi';
import { MetricChart, type ChartPoint } from '../MetricChart';

interface OverviewProps {
  windowDays: number;
  includeEvals: boolean;
  onUnauthorized: () => void;
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}
function fmtUsd2(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtUsdPrecise(n: number): string {
  // Sub-cent per-turn figures need more than 2dp to be meaningful.
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const MODEL_COLORS: Record<string, string> = {
  Sonnet: 'var(--ctp-mauve)',
  Haiku: 'var(--ctp-blue)',
  Voyage: 'var(--ctp-teal)',
  Other: 'var(--ctp-overlay1)',
};

export function Overview({
  windowDays,
  includeEvals,
  onUnauthorized,
}: OverviewProps) {
  const { data, loading, error } = useOpsApi<StatsData>({
    url: '/api/ops/stats',
    params: { windowDays, includeEvals },
    onUnauthorized,
  });

  if (error) {
    return (
      <div className="ops-panel ops-error">stats unavailable — {error}</div>
    );
  }
  if (!data) {
    return (
      <div className="ops-panel ops-muted">{loading ? 'loading…' : '—'}</div>
    );
  }

  const costPoints: ChartPoint[] = (
    [
      ['Sonnet', data.cost.by_model.sonnet],
      ['Haiku', data.cost.by_model.haiku],
      ['Voyage', data.cost.by_model.voyage],
      ['Other', data.cost.by_model.other],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([label, value]) => ({ label, value, color: MODEL_COLORS[label] }));

  const stepPoints: ChartPoint[] = data.latency.by_step.map((s) => ({
    label: s.step,
    value: s.avg_ms,
  }));

  const dailyPoints: ChartPoint[] = data.daily.map((d) => ({
    label: d.date.slice(5), // MM-DD
    value: d.count,
  }));

  const kpis: Array<{ label: string; value: string; title?: string }> = [
    { label: 'conversations', value: fmtCount(data.conversations) },
    { label: 'cost / turn', value: fmtUsdPrecise(data.cost.per_turn_usd) },
    { label: 'p50 latency', value: fmtMs(data.latency.p50_ms) },
    { label: 'grounded', value: `${data.grounded.percent}%` },
    {
      label: 'eval pass',
      value: '—',
      title: 'wired in the Evals tab (M4 D3)',
    },
    {
      label: 'injections',
      value: '—',
      title: 'wired in the Defense tab (M4 D2)',
    },
  ];

  return (
    <div className="ops-overview">
      <div className="ops-kpis">
        {kpis.map((k) => (
          <div className="ops-kpi" key={k.label} title={k.title}>
            <div className="ops-kpi-value">{k.value}</div>
            <div className="ops-kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="ops-grid-2">
        <section className="ops-panel">
          <h3 className="ops-panel-title">cost by model</h3>
          <div className="ops-panel-sub">
            {fmtUsd2(data.cost.total_usd)} total · {windowDays}d
          </div>
          <MetricChart type="bar" points={costPoints} format={fmtUsd2} />
        </section>

        <section className="ops-panel">
          <h3 className="ops-panel-title">latency by step</h3>
          <div className="ops-panel-sub">
            avg {fmtMs(data.latency.avg_ms)} / turn
          </div>
          <MetricChart type="bar" points={stepPoints} format={fmtMs} />
        </section>
      </div>

      <section className="ops-panel">
        <h3 className="ops-panel-title">conversations / day</h3>
        <div className="ops-panel-sub">
          {fmtCount(data.conversations)} real-human turns · eval{' '}
          {includeEvals ? 'included' : 'excluded'}
        </div>
        <MetricChart
          type="line"
          points={dailyPoints}
          format={(n) => String(Math.round(n))}
        />
      </section>
    </div>
  );
}
