// RAG tab — retrieval outcomes + reranker stats + pgvector index counts.

import { useOpsApi } from '../../../lib/opsApi';
import { MetricChart, type ChartPoint } from '../MetricChart';

interface RagData {
  outcomes: {
    total: number;
    retrieved: number;
    grounded: number;
    no_match: number;
    no_retrieval: number;
  };
  reranker: { runs: number; avg_latency_ms: number; total_cost_usd: number };
  index_counts: { source: string; chunks: number }[] | null;
}

interface Props {
  windowDays: number;
  includeEvals: boolean;
  onUnauthorized: () => void;
}

const pct = (n: number, d: number) =>
  d === 0 ? '0%' : `${Math.round((n / d) * 100)}%`;

export function Rag({ windowDays, includeEvals, onUnauthorized }: Props) {
  const { data, loading, error } = useOpsApi<RagData>({
    url: '/api/ops/rag',
    params: { windowDays, includeEvals },
    onUnauthorized,
  });

  if (error)
    return <div className="ops-panel ops-error">rag unavailable — {error}</div>;
  if (!data)
    return (
      <div className="ops-panel ops-muted">{loading ? 'loading…' : '—'}</div>
    );

  const o = data.outcomes;
  const outcomePoints: ChartPoint[] = [
    { label: 'grounded', value: o.grounded, color: 'var(--ctp-green)' },
    { label: 'no-match', value: o.no_match, color: 'var(--ctp-peach)' },
    {
      label: 'no-retrieval',
      value: o.no_retrieval,
      color: 'var(--ctp-overlay1)',
    },
  ];
  const indexPoints: ChartPoint[] =
    data.index_counts?.map((c) => ({ label: c.source, value: c.chunks })) ?? [];

  return (
    <div className="ops-overview">
      <div className="ops-kpis">
        <Kpi label="turns" value={String(o.total)} />
        <Kpi label="retrieval fired" value={pct(o.retrieved, o.total)} />
        <Kpi label="grounded" value={pct(o.grounded, o.total)} />
        <Kpi label="no-match" value={String(o.no_match)} />
        <Kpi label="rerank runs" value={String(data.reranker.runs)} />
        <Kpi label="rerank avg" value={`${data.reranker.avg_latency_ms}ms`} />
      </div>

      <div className="ops-grid-2">
        <section className="ops-panel">
          <h3 className="ops-panel-title">retrieval outcomes</h3>
          <div className="ops-panel-sub">
            {o.total} turns · {windowDays}d
          </div>
          <MetricChart type="bar" points={outcomePoints} />
        </section>

        <section className="ops-panel">
          <h3 className="ops-panel-title">index size (chunks / source)</h3>
          <div className="ops-panel-sub">
            {data.index_counts
              ? `${data.index_counts.reduce((a, c) => a + c.chunks, 0)} total chunks`
              : 'supabase unreachable'}
          </div>
          {data.index_counts ? (
            <MetricChart
              type="bar"
              points={indexPoints}
              color="var(--ctp-teal)"
            />
          ) : (
            <div className="ops-chart-empty">index counts unavailable</div>
          )}
        </section>
      </div>
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
