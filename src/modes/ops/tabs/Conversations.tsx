// Conversations tab — master/detail. Left: paginated, newest-first list
// (load-more, merge-deduped). Right: the selected trace's detail with a
// span waterfall, RAG outcome, scores, and an open-in-Langfuse link.

import { useEffect, useState } from 'react';
import { useOpsApi } from '../../../lib/opsApi';
import { TraceWaterfall, type TraceSpan } from '../TraceWaterfall';

interface ListItem {
  id: string;
  ts: string;
  latency_ms: number;
  cost_usd: number;
  tags: string[];
  grounded: boolean;
  refused: boolean;
  preview_q: string;
  preview_a: string;
}
interface ListResponse {
  items: ListItem[];
  page: number;
  total: number;
  hasMore: boolean;
}
interface Detail {
  id: string;
  ts: string;
  latency_ms: number;
  cost_usd: number;
  tags: string[];
  question: string;
  answer: string;
  spans: TraceSpan[];
  scores: unknown[];
  rag: { retrieved: boolean; no_match: boolean; sources: unknown[] };
  langfuse_url: string | null;
}

interface Props {
  windowDays: number;
  includeEvals: boolean;
  onUnauthorized: () => void;
}

const fmtMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
const fmtUsd = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtTime = (iso: string) => iso.slice(5, 16).replace('T', ' ');

export function Conversations({
  windowDays,
  includeEvals,
  onUnauthorized,
}: Props) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Reset paging when the window/eval scope changes.
  useEffect(() => {
    setPage(1);
    setSelected(null);
  }, [windowDays, includeEvals]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      windowDays: String(windowDays),
      includeEvals: String(includeEvals),
      page: String(page),
    });
    fetch(`/api/ops/traces?${qs}`, {
      credentials: 'same-origin',
      signal: ac.signal,
    })
      .then(async (res) => {
        if (res.status === 401) {
          onUnauthorized();
          throw new Error('unauthorized');
        }
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        return (await res.json()) as ListResponse;
      })
      .then((d) => {
        setItems((prev) => {
          if (page === 1) return d.items;
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...d.items.filter((i) => !seen.has(i.id))];
        });
        setHasMore(d.hasMore);
        setTotal(d.total);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'failed');
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [windowDays, includeEvals, page, onUnauthorized]);

  return (
    <div className="ops-conv">
      <div className="ops-conv-list">
        <div className="ops-panel-sub">
          {total} conversation{total === 1 ? '' : 's'} · newest first
        </div>
        {error && <div className="ops-error">{error}</div>}
        {items.map((it) => (
          <button
            key={it.id}
            className={`ops-conv-row${selected === it.id ? ' ops-conv-row--active' : ''}`}
            onClick={() => setSelected(it.id)}
          >
            <div className="ops-conv-q">{it.preview_q || '(no input)'}</div>
            <div className="ops-conv-meta">
              <span>{fmtTime(it.ts)}</span>
              <span>{fmtMs(it.latency_ms)}</span>
              <span>{fmtUsd(it.cost_usd)}</span>
              {it.grounded && (
                <span className="ops-pill ops-pill--g">grounded</span>
              )}
              {it.refused && (
                <span className="ops-pill ops-pill--r">refused</span>
              )}
            </div>
          </button>
        ))}
        {items.length === 0 && !loading && (
          <div className="ops-muted">no conversations in window</div>
        )}
        {hasMore && (
          <button
            className="ops-loadmore"
            disabled={loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {loading ? 'loading…' : 'load more'}
          </button>
        )}
      </div>

      <div className="ops-conv-detail">
        {selected ? (
          <Detail id={selected} onUnauthorized={onUnauthorized} />
        ) : (
          <div className="ops-muted ops-conv-empty">select a conversation</div>
        )}
      </div>
    </div>
  );
}

function Detail({
  id,
  onUnauthorized,
}: {
  id: string;
  onUnauthorized: () => void;
}) {
  const { data, loading, error } = useOpsApi<Detail>({
    url: `/api/ops/trace/${id}`,
    ttlMs: 60_000,
    onUnauthorized,
  });
  if (error)
    return <div className="ops-error">detail unavailable — {error}</div>;
  if (!data)
    return <div className="ops-muted">{loading ? 'loading…' : '—'}</div>;
  return (
    <div className="ops-detail">
      <div className="ops-detail-head">
        <div className="ops-detail-meta">
          {fmtTime(data.ts)} · {fmtMs(data.latency_ms)} ·{' '}
          {fmtUsd(data.cost_usd)}
          {data.rag.retrieved && (
            <span className="ops-pill ops-pill--g">rag</span>
          )}
          {data.rag.no_match && (
            <span className="ops-pill ops-pill--r">no-match</span>
          )}
        </div>
        {data.langfuse_url && (
          <a
            href={data.langfuse_url}
            target="_blank"
            rel="noreferrer"
            className="ops-lf-link"
          >
            open in Langfuse ↗
          </a>
        )}
      </div>

      <div className="ops-qa">
        <div className="ops-qa-label">Q</div>
        <div className="ops-qa-text">{data.question || '(no input)'}</div>
        <div className="ops-qa-label">A</div>
        <div className="ops-qa-text">{data.answer || '(no output)'}</div>
      </div>

      <h4 className="ops-detail-sub">spans</h4>
      <TraceWaterfall spans={data.spans} />

      {data.rag.sources.length > 0 && (
        <div className="ops-detail-row">
          <span className="ops-muted">rag sources:</span>{' '}
          {data.rag.sources.map(String).join(', ')}
        </div>
      )}
    </div>
  );
}
