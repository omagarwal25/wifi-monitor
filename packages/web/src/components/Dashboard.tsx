import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Line,
  ReferenceArea,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Metric {
  id: number;
  measuredAt: string;
  createdAt: string;
  routerLatencyMs: number | null;
  externalLatencyMs: number | null;
  routerPacketLoss: number;
  externalPacketLoss: number;
  routerReachable: boolean;
  externalReachable: boolean;
  downloadMbps: number | null;
  uploadMbps: number | null;
}

const TIME_RANGES = [
  { label: "1h", limit: 60 },
  { label: "6h", limit: 360 },
  { label: "12h", limit: 720 },
  { label: "24h", limit: 1440 },
];

const API_URL = import.meta.env.VITE_API_URL ?? "";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function computeDropoutRegions(
  metrics: Metric[],
  field: "routerReachable" | "externalReachable"
): { x1: string; x2: string }[] {
  const regions: { x1: string; x2: string }[] = [];
  let start: string | null = null;

  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];
    const down = !m[field];
    if (down && start === null) {
      start = m.measuredAt;
    } else if (!down && start !== null) {
      regions.push({ x1: start, x2: metrics[i - 1].measuredAt });
      start = null;
    }
  }
  if (start !== null && metrics.length > 0) {
    regions.push({ x1: start, x2: metrics[metrics.length - 1].measuredAt });
  }
  return regions;
}

function computeStats(metrics: Metric[]) {
  if (metrics.length === 0) {
    return { uptime: null, avgRouter: null, avgExternal: null, dropouts: 0 };
  }

  const reachableCount = metrics.filter((m) => m.externalReachable).length;
  const uptime = (reachableCount / metrics.length) * 100;

  const routerLatencies = metrics
    .map((m) => m.routerLatencyMs)
    .filter((v): v is number => v !== null);
  const externalLatencies = metrics
    .map((m) => m.externalLatencyMs)
    .filter((v): v is number => v !== null);

  const avgRouter =
    routerLatencies.length > 0
      ? routerLatencies.reduce((a, b) => a + b, 0) / routerLatencies.length
      : null;
  const avgExternal =
    externalLatencies.length > 0
      ? externalLatencies.reduce((a, b) => a + b, 0) / externalLatencies.length
      : null;

  let dropouts = 0;
  let wasDown = false;
  for (const m of metrics) {
    if (!m.externalReachable && !wasDown) {
      dropouts++;
      wasDown = true;
    } else if (m.externalReachable) {
      wasDown = false;
    }
  }

  return { uptime, avgRouter, avgExternal, dropouts };
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeIdx, setRangeIdx] = useState(2); // default 12h

  const limit = TIME_RANGES[rangeIdx].limit;

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/metrics?limit=${limit}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Metric[] = await res.json();
      setMetrics(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 60_000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const latest = metrics[metrics.length - 1] ?? null;

  function getStatus() {
    if (!latest) return null;
    if (!latest.routerReachable)
      return { label: "Router / WiFi issue", color: "var(--red)", dot: "🔴" };
    if (!latest.externalReachable)
      return { label: "ISP issue", color: "var(--yellow)", dot: "🟡" };
    return { label: "All good", color: "var(--green)", dot: "🟢" };
  }

  const status = getStatus();
  const stats = computeStats(metrics);

  const routerDropouts = computeDropoutRegions(metrics, "routerReachable");
  const externalDropouts = computeDropoutRegions(metrics, "externalReachable");
  const allDropouts = [
    ...routerDropouts.map((r) => ({ ...r, color: "rgba(232,64,64,0.15)" })),
    ...externalDropouts.map((r) => ({ ...r, color: "rgba(245,200,66,0.1)" })),
  ];

  const chartData = metrics.map((m) => ({
    time: m.measuredAt,
    routerLatencyMs: m.routerLatencyMs,
    externalLatencyMs: m.externalLatencyMs,
    routerPacketLoss: m.routerPacketLoss,
    externalPacketLoss: m.externalPacketLoss,
    downloadMbps: m.downloadMbps,
    uploadMbps: m.uploadMbps,
  }));

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>WiFi Monitor</h1>
        <div style={styles.rangeBar}>
          {TIME_RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
              style={{
                ...styles.rangeBtn,
                ...(i === rangeIdx ? styles.rangeBtnActive : {}),
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {status && (
        <div
          style={{
            ...styles.statusBanner,
            borderColor: status.color,
            color: status.color,
          }}
        >
          {status.dot} {status.label}
          {latest && (
            <span style={styles.statusTime}>
              &nbsp;— last update {formatTime(latest.measuredAt)}
            </span>
          )}
        </div>
      )}

      {loading && <p style={styles.info}>Loading…</p>}
      {error && <p style={{ ...styles.info, color: "var(--red)" }}>Error: {error}</p>}

      {!loading && metrics.length === 0 && !error && (
        <p style={styles.info}>No data yet.</p>
      )}

      {metrics.length > 0 && (
        <>
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Latency (ms)</h2>
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={formatTime}
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    unit=" ms"
                    width={52}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [
                      v != null ? `${(v as number).toFixed(1)} ms` : "—",
                      name === "routerLatencyMs" ? "Router" : "External",
                    ]}
                  />
                  <Legend
                    formatter={(v) => (v === "routerLatencyMs" ? "Router" : "External")}
                    wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }}
                  />
                  {allDropouts.map((r, i) => (
                    <ReferenceArea
                      key={i}
                      x1={r.x1}
                      x2={r.x2}
                      fill={r.color}
                      strokeOpacity={0}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="routerLatencyMs"
                    stroke="#f5a623"
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="externalLatencyMs"
                    stroke="#888"
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Packet Loss (%)</h2>
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={formatTime}
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    domain={[0, 100]}
                    unit="%"
                    width={40}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [
                      `${(v as number).toFixed(1)}%`,
                      name === "routerPacketLoss" ? "Router" : "External",
                    ]}
                  />
                  <Legend
                    formatter={(v) => (v === "routerPacketLoss" ? "Router" : "External")}
                    wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="routerPacketLoss"
                    stroke="#f5a623"
                    fill="rgba(245,166,35,0.15)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="externalPacketLoss"
                    stroke="#888"
                    fill="rgba(136,136,136,0.1)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Speed (Mbps) — hourly</h2>
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={formatTime}
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#444"
                    tick={{ fill: "#666", fontSize: 11, fontFamily: "monospace" }}
                    unit=" Mbps"
                    width={60}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [
                      v != null ? `${(v as number).toFixed(1)} Mbps` : "—",
                      name === "downloadMbps" ? "Download" : "Upload",
                    ]}
                  />
                  <Legend
                    formatter={(v) => (v === "downloadMbps" ? "Download" : "Upload")}
                    wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="downloadMbps"
                    stroke="#f5a623"
                    fill="rgba(245,166,35,0.15)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="uploadMbps"
                    stroke="#888"
                    fill="rgba(136,136,136,0.1)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section style={styles.statsRow}>
            <StatCard
              label="Uptime"
              value={stats.uptime !== null ? `${stats.uptime.toFixed(2)}%` : "—"}
            />
            <StatCard
              label="Avg Router Latency"
              value={stats.avgRouter !== null ? `${stats.avgRouter.toFixed(1)} ms` : "—"}
            />
            <StatCard
              label="Avg External Latency"
              value={stats.avgExternal !== null ? `${stats.avgExternal.toFixed(1)} ms` : "—"}
            />
            <StatCard
              label="Dropout Events"
              value={String(stats.dropouts)}
              highlight={stats.dropouts > 0}
            />
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div
        style={{
          ...styles.statValue,
          color: highlight ? "var(--red)" : "var(--amber)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #333",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: 12,
  color: "#e8e8e8",
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "24px 20px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
    borderBottom: "1px solid var(--border)",
    paddingBottom: 12,
  },
  title: {
    color: "var(--amber)",
    fontSize: 16,
    letterSpacing: "0.1em",
  },
  rangeBar: {
    display: "flex",
    gap: 4,
  },
  rangeBtn: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--dim)",
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
    letterSpacing: "0.05em",
  },
  rangeBtnActive: {
    border: "1px solid var(--amber)",
    color: "var(--amber)",
  },
  statusBanner: {
    border: "1px solid",
    padding: "10px 16px",
    marginBottom: 20,
    fontSize: 13,
    letterSpacing: "0.04em",
  },
  statusTime: {
    color: "var(--dim)",
    fontSize: 12,
  },
  info: {
    color: "var(--dim)",
    padding: "20px 0",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    color: "var(--dim)",
    marginBottom: 8,
    letterSpacing: "0.12em",
  },
  chartWrap: {
    border: "1px solid var(--border)",
    padding: "12px 4px 4px",
  },
  statsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 1,
    background: "var(--border)",
    border: "1px solid var(--border)",
    marginTop: 8,
  },
  statCard: {
    background: "var(--surface)",
    padding: "14px 16px",
  },
  statLabel: {
    fontSize: 10,
    color: "var(--dim)",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom: 6,
  },
  statValue: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--amber)",
    letterSpacing: "0.02em",
  },
};
