import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
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

interface PiEvent {
  id: number;
  occurredAt: string;
  label: string;
}

const TIME_RANGES = [
  { label: "1h", limit: 60 },
  { label: "6h", limit: 360 },
  { label: "12h", limit: 720 },
  { label: "24h", limit: 1440 },
];

const API_URL = import.meta.env.VITE_API_URL ?? "";

const AXIS = { stroke: "#444", tick: { fill: "#555", fontSize: 11, fontFamily: "monospace" } };
const TOOLTIP: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: 12,
  color: "#e8e8e8",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function computeDropoutRegions(metrics: Metric[], field: "routerReachable" | "externalReachable") {
  const regions: { x1: string; x2: string }[] = [];
  let start: string | null = null;
  for (let i = 0; i < metrics.length; i++) {
    const down = !metrics[i][field];
    if (down && start === null) start = metrics[i].measuredAt;
    else if (!down && start !== null) {
      regions.push({ x1: start, x2: metrics[i - 1].measuredAt });
      start = null;
    }
  }
  if (start !== null && metrics.length > 0)
    regions.push({ x1: start, x2: metrics[metrics.length - 1].measuredAt });
  return regions;
}

function computeStats(metrics: Metric[]) {
  if (!metrics.length) return { uptime: null, avgRouter: null, avgExternal: null, dropouts: 0 };
  const uptime = (metrics.filter((m) => m.externalReachable).length / metrics.length) * 100;
  const routerLats = metrics.map((m) => m.routerLatencyMs).filter((v): v is number => v !== null);
  const extLats = metrics.map((m) => m.externalLatencyMs).filter((v): v is number => v !== null);
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  let dropouts = 0, wasDown = false;
  for (const m of metrics) {
    if (!m.externalReachable && !wasDown) { dropouts++; wasDown = true; }
    else if (m.externalReachable) wasDown = false;
  }
  return { uptime, avgRouter: avg(routerLats), avgExternal: avg(extLats), dropouts };
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [events, setEvents] = useState<PiEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeIdx, setRangeIdx] = useState(2);

  const limit = TIME_RANGES[rangeIdx].limit;

  const fetchMetrics = useCallback(async () => {
    try {
      const [metricsRes, eventsRes] = await Promise.all([
        fetch(`${API_URL}/metrics?limit=${limit}`),
        fetch(`${API_URL}/events`),
      ]);
      if (!metricsRes.ok) throw new Error(`HTTP ${metricsRes.status}`);
      setMetrics(await metricsRes.json());
      if (eventsRes.ok) setEvents(await eventsRes.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, 60_000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  const latest = metrics[metrics.length - 1] ?? null;

  function getStatus() {
    if (!latest) return null;
    if (!latest.routerReachable) return { label: "Router / WiFi issue", color: "var(--red)",    dot: "🔴" };
    if (!latest.externalReachable) return { label: "ISP issue",          color: "var(--yellow)", dot: "🟡" };
    return { label: "All good", color: "var(--green)", dot: "🟢" };
  }

  const status = getStatus();
  const stats = computeStats(metrics);

  const allDropouts = [
    ...computeDropoutRegions(metrics, "routerReachable").map((r) => ({ ...r, fill: "rgba(232,64,64,0.15)" })),
    ...computeDropoutRegions(metrics, "externalReachable").map((r) => ({ ...r, fill: "rgba(245,200,66,0.1)" })),
  ];

  const windowStart = metrics.length ? metrics[0].measuredAt : null;
  const windowEnd   = metrics.length ? metrics[metrics.length - 1].measuredAt : null;
  const visibleEvents = events.filter((e) =>
    windowStart && windowEnd && e.occurredAt >= windowStart && e.occurredAt <= windowEnd
  );

  const isDotMode = rangeIdx === 0;
  const smoothWindow = [0, 5, 10, 15][rangeIdx];

  function smooth(arr: (number | null)[]): (number | null)[] {
    if (!smoothWindow) return arr;
    const half = Math.floor(smoothWindow / 2);
    return arr.map((_, i) => {
      const slice = arr.slice(Math.max(0, i - half), Math.min(arr.length, i + half + 1));
      const valid = slice.filter((v): v is number => v !== null);
      return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    });
  }

  const smoothed = {
    routerLatencyMs:    smooth(metrics.map((m) => m.routerLatencyMs)),
    externalLatencyMs:  smooth(metrics.map((m) => m.externalLatencyMs)),
    routerPacketLoss:   smooth(metrics.map((m) => m.routerPacketLoss)),
    externalPacketLoss: smooth(metrics.map((m) => m.externalPacketLoss)),
    downloadMbps:       smooth(metrics.map((m) => m.downloadMbps)),
    uploadMbps:         smooth(metrics.map((m) => m.uploadMbps)),
  };

  const chartData = metrics.map((m, i) => ({
    time: m.measuredAt,
    routerLatencyMs:    smoothed.routerLatencyMs[i],
    externalLatencyMs:  smoothed.externalLatencyMs[i],
    routerPacketLoss:   smoothed.routerPacketLoss[i],
    externalPacketLoss: smoothed.externalPacketLoss[i],
    downloadMbps:       smoothed.downloadMbps[i],
    uploadMbps:         smoothed.uploadMbps[i],
  }));

  return (
    <div className="max-w-[1100px] mx-auto px-5 py-6">

      {/* Header */}
      <header className="flex items-center justify-between pb-3 mb-4 border-b border-edge">
        <h1 className="text-accent text-base tracking-widest">WiFi Monitor</h1>
        <div className="flex gap-1">
          {TIME_RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
              className={[
                "border px-2.5 py-1 text-xs tracking-wide cursor-pointer bg-transparent transition-colors",
                i === rangeIdx
                  ? "border-accent text-accent"
                  : "border-edge text-muted hover:border-muted",
              ].join(" ")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {/* Status banner */}
      {status && (
        <div
          className="border px-4 py-2.5 mb-5 text-sm tracking-wide"
          style={{ borderColor: status.color, color: status.color }}
        >
          {status.dot} {status.label}
          {latest && (
            <span className="text-muted text-xs ml-1">
              — last update {formatTime(latest.measuredAt)}
            </span>
          )}
        </div>
      )}

      {loading && <p className="text-muted py-5">Loading…</p>}
      {error   && <p className="text-danger py-5">Error: {error}</p>}
      {!loading && !error && metrics.length === 0 && <p className="text-muted py-5">No data yet.</p>}

      {metrics.length > 0 && (
        <>
          {/* Latency */}
          <section className="mb-6">
            <h2 className="text-[10px] text-muted mb-2 tracking-widest">Latency (ms)</h2>
            <div className="border border-edge p-3 pr-1 pb-1">
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                  <XAxis dataKey="time" tickFormatter={formatTime} minTickGap={40} {...AXIS} />
                  <YAxis unit=" ms" width={52} domain={[0, (m: number) => Math.max(m * 1.2, 60)]} {...AXIS} />
                  <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [v != null ? `${(v as number).toFixed(1)} ms` : "—", name === "routerLatencyMs" ? "Router" : "External"]} />
                  <Legend formatter={(v) => v === "routerLatencyMs" ? "Router" : "External"} wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
                  {allDropouts.map((r, i) => <ReferenceArea key={i} x1={r.x1} x2={r.x2} fill={r.fill} strokeOpacity={0} />)}
                  <ReferenceLine y={50} stroke="rgba(245,166,35,0.4)" strokeDasharray="4 4"
                    label={{ value: "50ms", fill: "#f5a623", fontSize: 10, fontFamily: "monospace", position: "insideTopRight" }} />
                  <Line type="monotone" dataKey="routerLatencyMs"   stroke="#f5a623" strokeWidth={isDotMode ? 0 : 1.5} dot={isDotMode ? { r: 2, fill: "#f5a623", strokeWidth: 0 } : false} connectNulls={false} />
                  <Line type="monotone" dataKey="externalLatencyMs" stroke="#666"    strokeWidth={isDotMode ? 0 : 1.5} dot={isDotMode ? { r: 2, fill: "#666",    strokeWidth: 0 } : false} connectNulls={false} />
                  {visibleEvents.map((e) => (
                    <ReferenceLine key={e.id} x={e.occurredAt} stroke="rgba(100,160,255,0.6)" strokeDasharray="4 4"
                      label={{ value: e.label, fill: "#6aa0ff", fontSize: 10, fontFamily: "monospace", position: "insideTopLeft", angle: -90, dy: 4 }} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Packet loss */}
          <section className="mb-6">
            <h2 className="text-[10px] text-muted mb-2 tracking-widest">Packet Loss (%)</h2>
            <div className="border border-edge p-3 pr-1 pb-1">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                  <XAxis dataKey="time" tickFormatter={formatTime} minTickGap={40} {...AXIS} />
                  <YAxis domain={[0, (max: number) => max < 2 ? 5 : Math.ceil(max * 1.4)]} unit="%" width={40} {...AXIS} />
                  <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [`${(v as number).toFixed(1)}%`, name === "routerPacketLoss" ? "Router" : "External"]} />
                  <Legend formatter={(v) => v === "routerPacketLoss" ? "Router" : "External"} wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
                  <ReferenceLine y={1} stroke="rgba(245,166,35,0.4)" strokeDasharray="4 4"
                    label={{ value: "1%", fill: "#f5a623", fontSize: 10, fontFamily: "monospace", position: "insideTopRight" }} />
                  <Area type="monotone" dataKey="routerPacketLoss"   stroke="#f5a623" fill={isDotMode ? "none" : "rgba(245,166,35,0.12)"}  strokeWidth={isDotMode ? 0 : 1.5} dot={isDotMode ? { r: 2, fill: "#f5a623", strokeWidth: 0 } : false} />
                  <Area type="monotone" dataKey="externalPacketLoss" stroke="#666"    fill={isDotMode ? "none" : "rgba(100,100,100,0.08)"} strokeWidth={isDotMode ? 0 : 1.5} dot={isDotMode ? { r: 2, fill: "#666",    strokeWidth: 0 } : false} />
                  {visibleEvents.map((e) => (
                    <ReferenceLine key={e.id} x={e.occurredAt} stroke="rgba(100,160,255,0.6)" strokeDasharray="4 4" />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Speed */}
          <section className="mb-6">
            <h2 className="text-[10px] text-muted mb-2 tracking-widest">Speed (Mbps) — hourly</h2>
            <div className="border border-edge p-3 pr-1 pb-1">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
                  <XAxis dataKey="time" tickFormatter={formatTime} minTickGap={40} {...AXIS} />
                  <YAxis width={44} domain={[0, (m: number) => Math.max(m * 1.2, 220)]} {...AXIS} />
                  <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => formatTime(v as string)}
                    formatter={(v, name) => [v != null ? `${(v as number).toFixed(1)} Mbps` : "—", name === "downloadMbps" ? "Download" : "Upload"]} />
                  <Legend formatter={(v) => v === "downloadMbps" ? "Download" : "Upload"} wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
                  {/* acceptable band 150–200 Mbps */}
                  <ReferenceArea y1={150} y2={200} fill="rgba(76,175,80,0.08)" strokeOpacity={0} />
                  <ReferenceLine y={150} stroke="rgba(76,175,80,0.5)" strokeDasharray="3 3" />
                  <ReferenceLine y={200} stroke="rgba(76,175,80,0.5)" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="downloadMbps" stroke="#f5a623" fill={isDotMode ? "none" : "rgba(245,166,35,0.12)"}  strokeWidth={isDotMode ? 0 : 1.5} dot={{ r: 3, fill: "#f5a623", strokeWidth: 0 }} connectNulls={true} />
                  <Area type="monotone" dataKey="uploadMbps"   stroke="#666"    fill={isDotMode ? "none" : "rgba(100,100,100,0.08)"} strokeWidth={isDotMode ? 0 : 1.5} dot={{ r: 3, fill: "#666",    strokeWidth: 0 }} connectNulls={true} />
                  {visibleEvents.map((e) => (
                    <ReferenceLine key={e.id} x={e.occurredAt} stroke="rgba(100,160,255,0.6)" strokeDasharray="4 4" />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Stats row */}
          <section className="grid grid-cols-4 gap-px bg-edge border border-edge mt-2">
            <StatCard label="Uptime"               value={stats.uptime     !== null ? `${stats.uptime.toFixed(2)}%`    : "—"} />
            <StatCard label="Avg Router Latency"   value={stats.avgRouter  !== null ? `${stats.avgRouter.toFixed(1)} ms` : "—"} />
            <StatCard label="Avg External Latency" value={stats.avgExternal !== null ? `${stats.avgExternal.toFixed(1)} ms` : "—"} />
            <StatCard label="Dropout Events"       value={String(stats.dropouts)} highlight={stats.dropouts > 0} />
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="text-[10px] text-muted uppercase tracking-widest mb-1.5">{label}</div>
      <div className={`text-[22px] font-bold tracking-wide ${highlight ? "text-danger" : "text-accent"}`}>
        {value}
      </div>
    </div>
  );
}
