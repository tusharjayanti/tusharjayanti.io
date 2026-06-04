// Pure helpers for the System tab: free-tier headroom math + rate-limit
// counter summary. The handler (api/ops/system.ts) gathers the raw numbers
// (Langfuse prompt + observation count, Upstash rate-limit keys); these
// functions shape them. Kept pure for fixture tests.

export interface HeadroomBar {
  key: string;
  label: string;
  used: number;
  cap: number;
  cap_label: string;
  pct: number; // 0-100, one decimal, clamped
}

export function headroomBar(
  key: string,
  label: string,
  used: number,
  cap: number,
  cap_label: string,
): HeadroomBar {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 1000) / 10) : 0;
  return { key, label, used, cap, cap_label, pct };
}

export interface RateLimitSummary {
  window: string;
  requests: number;
  distinct_ips: number;
  at_cap: number; // IPs that hit the per-IP cap this window
  per_ip_cap: number;
}

// Summarize the current-hour chat rate-limit buckets. `counts` is the
// per-IP request count for the window (one entry per active IP).
export function summarizeRateLimits(
  counts: number[],
  perIpCap: number,
  window: string,
): RateLimitSummary {
  return {
    window,
    requests: counts.reduce((a, c) => a + c, 0),
    distinct_ips: counts.length,
    at_cap: counts.filter((c) => c >= perIpCap).length,
    per_ip_cap: perIpCap,
  };
}

export interface PromptInfo {
  name: string;
  version: number;
  hash: string;
  canary_prefix: string;
  // Best-effort from the Langfuse prompts API; null when unavailable.
  labels: string[] | null;
  updated_at: string | null;
}

export interface SystemData {
  prompt: PromptInfo;
  rate_limits: RateLimitSummary;
  headroom: HeadroomBar[];
  providers: { name: string; region: string; plan: string }[];
}
