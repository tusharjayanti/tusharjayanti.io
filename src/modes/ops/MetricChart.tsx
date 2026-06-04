// One small recharts wrapper for the ops dashboard so chart code stays
// DRY and visually consistent. type='bar' (horizontal) for cost-by-model
// / latency-by-step, type='line' (area) for the conversations/day series.
// Lives in the lazy /ops chunk, so recharts never touches the public bundle.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ChartPoint {
  label: string;
  value: number;
  color?: string;
}

interface MetricChartProps {
  type: 'bar' | 'line';
  points: ChartPoint[];
  // Render a raw value into its display string (e.g. USD, ms, count).
  format?: (n: number) => string;
  height?: number;
  // Accent for the line / default bar fill.
  color?: string;
}

const MAUVE = 'var(--ctp-mauve)';

// Catppuccin-themed tooltip shared by both chart types.
function tooltipStyle() {
  return {
    contentStyle: {
      background: 'var(--ctp-crust)',
      border: '1px solid var(--ctp-surface1)',
      borderRadius: 6,
      fontSize: 12,
      fontFamily: 'var(--font-mono)',
      color: 'var(--ctp-text)',
    },
    labelStyle: { color: 'var(--ctp-subtext0)' },
    itemStyle: { color: 'var(--ctp-text)' },
  };
}

const AXIS_TICK = {
  fill: 'var(--ctp-overlay1)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
};

export function MetricChart({
  type,
  points,
  format = (n) => String(n),
  height,
  color = MAUVE,
}: MetricChartProps) {
  if (points.length === 0) {
    return <div className="ops-chart-empty">no data in window</div>;
  }

  if (type === 'bar') {
    const h = height ?? Math.max(points.length * 34 + 24, 96);
    return (
      <ResponsiveContainer width="100%" height={h}>
        <BarChart
          layout="vertical"
          data={points}
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={110}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--ctp-surface0)', opacity: 0.3 }}
            formatter={(v) => [format(Number(v)), 'value']}
            {...tooltipStyle()}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.color ?? color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height ?? 180}>
      <AreaChart
        data={points}
        margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
      >
        <defs>
          <linearGradient id="ops-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis hide />
        <Tooltip
          cursor={{ stroke: 'var(--ctp-surface2)' }}
          formatter={(v) => [format(Number(v)), 'count']}
          {...tooltipStyle()}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill="url(#ops-area)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
