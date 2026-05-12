import React, { useEffect, useState } from "react";
import MonitoringTabs from "./MonitoringTabs";
import styles from "./MonitoringStyles.module.css";
import pageLayout from "../../components/system/SystemLayout.module.css";
import { getAdminTraffic } from "../../api/auth";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

export default function AdminTraffic() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getAdminTraffic();
        if (res.ok) setData(res);
      } finally {
        setLoading(false);
      }
    };
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) return <div className={pageLayout.page}>Loading..</div>;
  if (!data) return <div className={pageLayout.page}>Failed to load traffic data</div>;

  const { summary, by_path, timeline, recent } = data;

  return (
    <div className={pageLayout.page}>
      <MonitoringTabs 
        title="Traffic & API Gateway" 
        subtitle="Real-time web requests, error rates, and latency analytics."
      />

      <div className={styles.grid4}>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Requests (Buffer)</div>
          <div className={styles.kpiBig}>{summary.total}</div>
          <div className={styles.panelSub}>In memory log buffer</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Error Rate</div>
          <div className={styles.kpiBig} style={{color: summary.error_rate > 5 ? "#ef4444" : "#22c55e"}}>{summary.error_rate}%</div>
          <div className={styles.panelSub}>{summary.errors} errors (4xx, 5xx)</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Avg Latency</div>
          <div className={styles.kpiBig}>{summary.avg_ms} ms</div>
          <div className={styles.panelSub}>Average response time</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>p95 Latency</div>
          <div className={styles.kpiBig} style={{color: summary.p95_ms > 500 ? "#f59e0b" : "var(--text)"}}>{summary.p95_ms} ms</div>
          <div className={styles.panelSub}>95% of requests are faster</div>
        </div>
      </div>

      <div className={styles.panel} style={{marginBottom: 20}}>
        <div className={styles.panelTitle}>Requests Timeline (Last 30m)</div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={timeline} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="ts" tickFormatter={ts => new Date(ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})} tick={{fontSize: 11, fill: "var(--muted)"}} />
            <YAxis tick={{fontSize: 11, fill: "var(--muted)"}} />
            <Tooltip contentStyle={{background: "var(--surface-2)", border: "none", borderRadius: 8}} labelFormatter={ts => new Date(ts).toLocaleTimeString()} />
            <Area type="monotone" dataKey="requests" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorReq)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.grid2}>
        <div className={styles.panel} style={{overflowY: "auto", maxHeight: 400}}>
          <div className={styles.panelTitle}>Top Endpoints by Volume</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Hits</th>
                <th>Avg Latency</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {by_path.map((p, i) => (
                <tr key={i}>
                  <td style={{fontFamily: "monospace", fontSize: "0.8rem", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}} title={p.path}>{p.path}</td>
                  <td>{p.count}</td>
                  <td style={{color: p.avg_ms > 300 ? "#f59e0b" : "var(--text)"}}>{p.avg_ms}ms</td>
                  <td style={{color: p.errors > 0 ? "#ef4444" : "var(--muted)"}}>{p.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.panel} style={{overflowY: "auto", maxHeight: 400}}>
          <div className={styles.panelTitle}>Recent Request Log</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Status</th>
                <th>Lat</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className={styles.panelSub}>{new Date(r.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</td>
                  <td><span style={{fontSize: "0.75rem", padding: "2px 6px", background: "var(--surface-2)", borderRadius: 4, color: r.method==="GET"?"#3b82f6":"#22c55e"}}>{r.method}</span></td>
                  <td style={{color: r.status >= 400 ? "#ef4444" : "#22c55e"}}>{r.status}</td>
                  <td>{r.ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
