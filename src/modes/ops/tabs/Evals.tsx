// Evals tab — the differentiator: baseline-HISTORY (retrieval@1 + assertion
// pass-rate over commits), not a single snapshot. Plus latest-run KPIs,
// per-category bars, and the live merge-gate verdict.

import { useOpsApi } from '../../../lib/opsApi';
import { MetricChart, type ChartPoint } from '../MetricChart';

interface TrendPoint {
  sha: string;
  full_sha: string;
  timestamp: string;
  retrieval_at_1: number;
  retrieval_at_5: number;
  mrr: number;
  pass_rate: number;
}
interface GateReason {
  severity: 'block' | 'warn';
  code: string;
  message: string;
}
interface EvalsData {
  run_count: number;
  baseline_sha: string | null;
  trend: TrendPoint[];
  latest: {
    sha: string;
    branch: string;
    timestamp: string;
    retrieval_at_1: number;
    retrieval_at_5: number;
    mrr: number;
    ooc_correct_rate: number;
    pass_rate: number;
    models: { embedding: string; rerank: string; response: string };
  } | null;
  categories: {
    category: string;
    pass_rate: number;
    pass_count: number;
    query_count: number;
  }[];
  gate: { passed: boolean; bootstrap: boolean; reasons: GateReason[] } | null;
}

const fpct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function Evals({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { data, loading, error } = useOpsApi<EvalsData>({
    url: '/api/ops/evals',
    onUnauthorized,
  });

  if (error)
    return (
      <div className="ops-panel ops-error">evals unavailable — {error}</div>
    );
  if (!data)
    return (
      <div className="ops-panel ops-muted">{loading ? 'loading…' : '—'}</div>
    );
  if (!data.latest) {
    return <div className="ops-panel ops-muted">no eval runs recorded yet</div>;
  }

  const L = data.latest;
  const r1Points: ChartPoint[] = data.trend.map((t) => ({
    label: t.sha.slice(0, 7),
    value: t.retrieval_at_1,
  }));
  const passPoints: ChartPoint[] = data.trend.map((t) => ({
    label: t.sha.slice(0, 7),
    value: t.pass_rate,
  }));
  const catPoints: ChartPoint[] = data.categories.map((c) => ({
    label: c.category,
    value: c.pass_rate,
    color: c.pass_rate >= 1 ? 'var(--ctp-green)' : 'var(--ctp-peach)',
  }));

  return (
    <div className="ops-overview">
      <GateBanner gate={data.gate} baselineSha={data.baseline_sha} />

      <div className="ops-kpis">
        <Kpi label="retrieval@1" value={fpct(L.retrieval_at_1)} />
        <Kpi label="retrieval@5" value={fpct(L.retrieval_at_5)} />
        <Kpi label="mrr" value={L.mrr.toFixed(3)} />
        <Kpi label="pass rate" value={fpct(L.pass_rate)} />
        <Kpi label="ooc guard" value={fpct(L.ooc_correct_rate)} />
        <Kpi label="runs" value={String(data.run_count)} />
      </div>

      <div className="ops-grid-2">
        <section className="ops-panel">
          <h3 className="ops-panel-title">retrieval@1 over commits</h3>
          <div className="ops-panel-sub">
            {data.run_count} runs · latest {L.sha}
          </div>
          <MetricChart type="line" points={r1Points} format={fpct} />
        </section>
        <section className="ops-panel">
          <h3 className="ops-panel-title">assertion pass-rate over commits</h3>
          <div className="ops-panel-sub">behavioral guardrails</div>
          <MetricChart
            type="line"
            points={passPoints}
            format={fpct}
            color="var(--ctp-green)"
          />
        </section>
      </div>

      <section className="ops-panel">
        <h3 className="ops-panel-title">latest category pass-rates</h3>
        <div className="ops-panel-sub">
          {L.models.response} · {L.models.rerank} · {L.models.embedding}
        </div>
        <MetricChart type="bar" points={catPoints} format={fpct} />
      </section>
    </div>
  );
}

function GateBanner({
  gate,
  baselineSha,
}: {
  gate: EvalsData['gate'];
  baselineSha: string | null;
}) {
  if (!gate) {
    return (
      <div className="ops-gate-banner ops-gate-banner--neutral">
        no baseline comparison{' '}
        {baselineSha ? `(baseline ${baselineSha.slice(0, 8)})` : ''}
      </div>
    );
  }
  const blocks = gate.reasons.filter((r) => r.severity === 'block');
  return (
    <div
      className={`ops-gate-banner ${
        gate.passed ? 'ops-gate-banner--pass' : 'ops-gate-banner--fail'
      }`}
    >
      <strong>
        gate: {gate.passed ? 'pass' : `${blocks.length} blocking`}
      </strong>
      {gate.bootstrap && <span> · bootstrap (seeds baseline on merge)</span>}
      {blocks.slice(0, 3).map((r) => (
        <div className="ops-gate-reason" key={r.code}>
          {r.message}
        </div>
      ))}
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
