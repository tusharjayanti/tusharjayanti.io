// Span waterfall for a single trace: each observation as a bar positioned
// by its offset from the first span and sized by duration. Pure layout math
// against the total wall-clock span.

export interface TraceSpan {
  name: string;
  model: string;
  offset_ms: number;
  duration_ms: number;
  cost_usd: number;
}

const STEP_COLOR: Record<string, string> = {
  anthropic_first_call: 'var(--ctp-mauve)',
  anthropic_second_call: 'var(--ctp-lavender)',
  sonnet_response: 'var(--ctp-mauve)',
  rerank: 'var(--ctp-blue)',
  embedding: 'var(--ctp-teal)',
};

export function TraceWaterfall({ spans }: { spans: TraceSpan[] }) {
  if (spans.length === 0) {
    return <div className="ops-muted">no spans recorded</div>;
  }
  const end = Math.max(...spans.map((s) => s.offset_ms + s.duration_ms), 1);
  return (
    <div className="ops-waterfall">
      {spans.map((s, i) => (
        <div className="ops-wf-row" key={i}>
          <span className="ops-wf-name">{s.name}</span>
          <span className="ops-wf-track">
            <span
              className="ops-wf-bar"
              style={{
                marginLeft: `${(s.offset_ms / end) * 100}%`,
                width: `${Math.max((s.duration_ms / end) * 100, 1)}%`,
                background: STEP_COLOR[s.name] ?? 'var(--ctp-overlay1)',
              }}
            />
          </span>
          <span className="ops-wf-dur">{s.duration_ms}ms</span>
        </div>
      ))}
    </div>
  );
}
