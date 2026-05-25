// Pure formatting helpers for the ops snippet widget. Kept separate
// from the React component so they're unit-testable without JSDOM.

export interface OpsSnippetData {
  visitors: number;
  queries: number;
  tokens: number;
  grounded_percent: number;
  cost_usd: number;
  last_aggregated_at: string;
  is_offline: false;
}

export interface OpsSnippetOffline {
  visitors: null;
  queries: null;
  tokens: null;
  grounded_percent: null;
  cost_usd: null;
  last_aggregated_at: null;
  is_offline: true;
}

export type OpsSnippet = OpsSnippetData | OpsSnippetOffline;

// Populated = fetch landed AND the snippet has at least one
// non-zero metric AND a non-null timestamp AND is_offline is false.
// The "any-positive" check is the load-bearing one — without it
// the HUD would render four zeros on a freshly-deployed site that
// hasn't seen any traffic yet. Better to hide entirely than to
// show a zeroed display that looks broken.
export function isPopulated(
  snippet: OpsSnippet | null,
): snippet is OpsSnippetData {
  if (snippet === null) return false;
  if (snippet.is_offline) return false;
  if (snippet.last_aggregated_at === null) return false;
  return (
    (snippet.visitors ?? 0) > 0 ||
    (snippet.queries ?? 0) > 0 ||
    (snippet.tokens ?? 0) > 0
  );
}

// Humanize a non-negative integer. Spec example: 1247 -> "1.2K",
// 1_247_000 -> "1.2M". Below 1000 we render the raw integer.
// One decimal place always shown for K/M (the spec sample "1.2M"
// shows the decimal even when it'd be a trailing zero).
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

// grounded_percent — integer percent, e.g. 62 -> "62%".
export function formatPercent(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0%';
  return `${Math.round(n)}%`;
}

// cost_usd — always two decimals with a leading $, e.g. 3.4 -> "$3.40".
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0.00';
  return `$${n.toFixed(2)}`;
}

// "HH:MM UTC" from an ISO timestamp. Returns "--:--" if parsing fails
// — should never happen for non-offline blobs but defensive.
export function formatUtcTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '--:--';
  const d = new Date(ts);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} UTC`;
}

export interface OpsSnippetView {
  is_offline: boolean;
  rows: Array<{ label: string; value: string }>;
  // "14:32 UTC" for live data, "offline" for the failure state.
  footer: string;
  // Abbreviated single-row string used at ≤768px viewports.
  // "247 vis · 89 q · 1.2M tok · 2.1 t/t" or "offline" when offline.
  mobile: string;
}

export function buildOpsView(snippet: OpsSnippet | null): OpsSnippetView {
  if (snippet === null || snippet.is_offline) {
    return {
      is_offline: true,
      rows: [
        { label: 'visitors', value: '--' },
        { label: 'queries', value: '--' },
        { label: 'tokens', value: '--' },
        { label: 'queries_grounded', value: '--' },
        { label: 'cost', value: '--' },
      ],
      footer: 'offline',
      mobile: 'offline',
    };
  }
  const v = formatCount(snippet.visitors);
  const q = formatCount(snippet.queries);
  const t = formatCount(snippet.tokens);
  const g = formatPercent(snippet.grounded_percent);
  const c = formatUsd(snippet.cost_usd);
  return {
    is_offline: false,
    rows: [
      { label: 'visitors', value: v },
      { label: 'queries', value: q },
      { label: 'tokens', value: t },
      { label: 'queries_grounded', value: g },
      { label: 'cost', value: c },
    ],
    footer: formatUtcTime(snippet.last_aggregated_at),
    mobile: `${v} visitors · ${q} queries · ${g} grounded · ${c}`,
  };
}
