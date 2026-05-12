import React, { useEffect, useState } from "react";
import MonitoringTabs from "./MonitoringTabs";
import styles from "./MonitoringStyles.module.css";
import pageLayout from "../../components/system/SystemLayout.module.css";
import { getAdminModelAnalytics } from "../../api/auth";
import { formatDate } from "../../utils/formatDate";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#8b5cf6'];

export default function AdminModelAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getAdminModelAnalytics();
        if (res.ok) setData(res);
      } finally {
        setLoading(false);
      }
    };
    fetch();
    const interval = setInterval(fetch, 60000); // Models don't change as fast, 60s is fine
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) return <div className={pageLayout.page}>Loading..</div>;
  if (!data) return <div className={pageLayout.page}>Failed to load model analytics</div>;

  const { model_stats, verdict_dist, platform_breakdown, score_dist, trend } = data;

  // Format verdict data for Pie Chart
  const pieData = Object.entries(verdict_dist).map(([name, value]) => ({ name, value }));

  return (
    <div className={pageLayout.page}>
      <MonitoringTabs 
        title="AI Model Forensic Analytics" 
        subtitle="Performance of underlying ML models (Wav2Lip, ViT, Xception), scores, and classification distribution."
      />

      <div className={styles.grid2}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>Overall Verdict Distribution</div>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => {
                    let color = '#8b5cf6';
                    if (entry.name === 'FAKE') color = '#ef4444';
                    if (entry.name === 'SUSPICIOUS') color = '#f59e0b';
                    if (entry.name === 'REAL') color = '#22c55e';
                    return <Cell key={`cell-${index}`} fill={color} />;
                  })}
                </Pie>
                <Tooltip contentStyle={{background: "var(--surface-2)", border: "none", borderRadius: 8}} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
             <div className={styles.panelSub} style={{textAlign: "center", padding: 40}}>No classifications yet.</div>
          )}
        </div>

        <div className={styles.panel}>
          <div className={styles.panelTitle}>Confidence Score Distribution (Final Fusion)</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={score_dist} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="range" tick={{fontSize: 10, fill: "var(--muted)"}} angle={-45} textAnchor="end" height={60} />
              <YAxis tick={{fontSize: 11, fill: "var(--muted)"}} />
              <Tooltip contentStyle={{background: "var(--surface-2)", border: "none", borderRadius: 8}} cursor={{fill: 'rgba(255,255,255,0.05)'}} />
              <Bar dataKey="count" name="Analyses" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className={styles.panel} style={{marginBottom: 20}}>
        <div className={styles.panelTitle}>Detection Trend (Last 7 Days)</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{fontSize: 11, fill: "var(--muted)"}} />
            <YAxis tick={{fontSize: 11, fill: "var(--muted)"}} />
            <Tooltip contentStyle={{background: "var(--surface-2)", border: "none", borderRadius: 8}} labelFormatter={val => formatDate(val)} />
            <Legend wrapperStyle={{fontSize: 12}} />
            <Bar dataKey="real" name="Authentic (REAL)" stackId="a" fill="#22c55e" />
            <Bar dataKey="fake" name="Manipulated (FAKE)" stackId="a" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>Sub-Model Performance Metrics</div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Model Name</th>
              <th>Total Executions</th>
              <th>Success Rate</th>
              <th>Avg Output Score</th>
              <th>Predicton Bias</th>
            </tr>
          </thead>
          <tbody>
            {model_stats.map((m, i) => (
              <tr key={i}>
                <td><strong style={{textTransform: "capitalize"}}>{m.model}</strong></td>
                <td>{m.total}</td>
                <td style={{color: m.total > 0 && m.done/m.total < 0.9 ? "#ef4444" : "var(--text)"}}>
                  {m.total > 0 ? Math.round((m.done/m.total)*100) : 0}%
                </td>
                <td>{m.avg_score !== null ? (Math.round(m.avg_score * 100) + '%') : "—"}</td>
                <td className={styles.panelSub}>
                  {Object.entries(m.verdict_counts).map(([v, c]) => `${v}: ${c}`).join(" | ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
