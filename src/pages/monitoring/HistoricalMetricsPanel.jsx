import React, { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import styles from "./MonitoringStyles.module.css";
import { getAdminMetricsHistory } from "../../api/auth";

const RANGES = [
  { key: "15m", label: "15 min" },
  { key: "1h",  label: "1 hour" },
  { key: "6h",  label: "6 hours" },
  { key: "24h", label: "24 hours" },
  { key: "custom", label: "Custom" }
];

const METRIC_GROUPS = {
  resources: {
    key: "resources",
    label: "CPU & RAM",
    lines: [
      { key: "cpu",  name: "CPU %",  color: "#f59e0b", unit: "%" },
      { key: "ram",  name: "RAM %",  color: "#ef4444", unit: "%" },
    ],
    domain: [0, 100],
  },
  disk: {
    key: "disk",
    label: "Disk Usage",
    lines: [
      { key: "disk", name: "Disk %", color: "#a78bfa", unit: "%" },
    ],
    domain: [0, 100],
  },
  queue: {
    key: "queue",
    label: "Queue & Tasks",
    lines: [
      { key: "queue",  name: "Queued jobs",   color: "#3b82f6", unit: "" },
      { key: "active", name: "Active tasks",  color: "#22c55e", unit: "" },
      { key: "stuck",  name: "Stuck jobs",    color: "#ef4444", unit: "" },
    ],
    domain: [0, "auto"],
  }
};

function formatChartTs(isoStr, rangeKey) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (rangeKey === "24h") {
    return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(d);
  }
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}

export default function HistoricalMetricsPanel({ defaultGroup, availableGroups }) {
  const [selectedRange, setSelectedRange] = useState("1h");
  const [selectedGroup, setSelectedGroup] = useState(defaultGroup);
  const [historyData, setHistoryData] = useState([]);
  const [loading, setLoading] = useState(false);
  const rangeRef = useRef("1h");
  
  // Custom date handling
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customRef = useRef({ start: null, end: null });

  const loadHistory = useCallback(async (range, custOpts = null) => {
    setLoading(true);
    try {
      const opts = custOpts || (range === "custom" ? customRef.current : { start: null, end: null });
      
      const res = await getAdminMetricsHistory(
        range, 
        opts.start ? new Date(opts.start).toISOString() : null, 
        opts.end ? new Date(opts.end).toISOString() : null
      );
      if (res.ok) setHistoryData(res.data);
    } catch { 
      // handle error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory(rangeRef.current);
    const interval = setInterval(() => {
      // Don't auto-poll if looking at a fixed custom historical window
      if (rangeRef.current !== "custom") {
        loadHistory(rangeRef.current);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  const handleRangeChange = (range) => {
    setSelectedRange(range);
    rangeRef.current = range;
    if (range !== "custom") {
      loadHistory(range);
    }
  };

  const applyCustomRange = () => {
    if (!customStart || !customEnd) return;
    customRef.current = { start: customStart, end: customEnd };
    handleRangeChange("custom");
    loadHistory("custom", customRef.current);
  };

  const group = METRIC_GROUPS[selectedGroup];
  const tickCount = Math.min(historyData.length, selectedRange === "24h" ? 8 : 6);

  return (
    <div className={styles.panel} style={{ marginTop: 20 }}>
      {/* Header controls layout modeled after observability dashboards (like Zabbix) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
        <div>
          <div className={styles.panelTitle} style={{marginBottom: 4}}>Historical Telemetry <span className={styles.panelSub} style={{marginLeft: 8}}>{historyData.length} checkpoints</span></div>
          <div className={styles.panelSub}>Time-series metric storage spanning system performance.</div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {/* Select Component Group */}
          {availableGroups.length > 1 && (
            <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: 8, padding: 4 }}>
              {availableGroups.map((gk) => (
                <button
                  key={gk}
                  onClick={() => setSelectedGroup(gk)}
                  style={{
                    padding: "6px 12px", border: "none", borderRadius: 6, fontSize: "0.8rem", fontWeight: 600, cursor: "pointer",
                    background: selectedGroup === gk ? "var(--accent)" : "transparent",
                    color: selectedGroup === gk ? "#fff" : "var(--muted)",
                  }}
                >
                  {METRIC_GROUPS[gk].label}
                </button>
              ))}
            </div>
          )}
          {/* Select Time Range */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: 8, padding: 4 }}>
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => handleRangeChange(r.key)}
                  style={{
                    padding: "6px 12px", border: "none", borderRadius: 6, fontSize: "0.8rem", fontWeight: 600, cursor: "pointer",
                    background: selectedRange === r.key ? "var(--text)" : "transparent",
                    color: selectedRange === r.key ? "var(--bg)" : "var(--text)",
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {selectedRange === "custom" && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "var(--surface-2)", padding: 4, borderRadius: 8 }}>
                <input 
                  type="datetime-local" 
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", fontSize: "0.8rem", colorScheme: "dark" }}
                  title="From"
                />
                <span style={{color: "var(--muted)", fontSize: "0.8rem"}}>to</span>
                <input 
                  type="datetime-local" 
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", fontSize: "0.8rem", colorScheme: "dark" }}
                  title="To"
                />
                <button onClick={applyCustomRange} style={{ padding: "4px 10px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 4, fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>
                  Apply
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ height: 260, position: "relative" }}>
        {loading && historyData.length === 0 && (
          <div style={{position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center"}}>Loading...</div>
        )}
        {!loading && historyData.length === 0 && (
          <div style={{position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)"}}>No telemetry data collected yet. Polling background service...</div>
        )}
        {historyData.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={historyData} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="ts"
                tickFormatter={(v) => formatChartTs(v, selectedRange)}
                tick={{ fontSize: 11, fill: "var(--muted)" }}
                interval={Math.max(0, Math.floor(historyData.length / tickCount) - 1)}
                tickLine={false}
              />
              <YAxis
                domain={group.domain}
                tick={{ fontSize: 11, fill: "var(--muted)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => group.lines[0].unit ? `${v}${group.lines[0].unit}` : v}
              />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
                labelFormatter={(v) => formatChartTs(v, selectedRange)}
                formatter={(val, name) => {
                  const line = group.lines.find(l => l.name === name);
                  return [`${val ?? 0}${line?.unit ?? ""}`, name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {group.lines.map((l) => (
                <Line
                  key={l.key}
                  type="monotone"
                  dataKey={l.key}
                  name={l.name}
                  stroke={l.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
