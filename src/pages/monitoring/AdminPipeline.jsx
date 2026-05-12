import React, { useEffect, useState } from "react";
import MonitoringTabs from "./MonitoringTabs";
import styles from "./MonitoringStyles.module.css";
import pageLayout from "../../components/system/SystemLayout.module.css";
import { getAdminPipeline } from "../../api/auth";
import { formatDateTime } from "../../utils/formatDate";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import HistoricalMetricsPanel from "./HistoricalMetricsPanel";

export default function AdminPipeline() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getAdminPipeline();
        if (res.ok) setData(res);
      } finally {
        setLoading(false);
      }
    };
    fetch();
    const interval = setInterval(fetch, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) return <div className={pageLayout.page}>Loading..</div>;
  if (!data) return <div className={pageLayout.page}>Failed to load pipeline data</div>;

  const { jobs, throughput, incidents, extension } = data;

  return (
    <div className={pageLayout.page}>
      <MonitoringTabs 
        title="Application Pipeline" 
        subtitle="Asynchronous processing queue, deepfake analysis throughput, and incidents."
      />

      <HistoricalMetricsPanel defaultGroup="queue" availableGroups={["queue"]} />

      <div className={styles.grid4} style={{marginTop: 20}}>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Total Analyses</div>
          <div className={styles.kpiBig}>{jobs.total}</div>
          <div className={styles.panelSub}>{jobs.success_rate}% success rate</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Processing (Pending)</div>
          <div className={styles.kpiBig} style={{color: "#3b82f6"}}>{jobs.pending}</div>
          <div className={styles.panelSub}>In queue / active</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Stuck Jobs</div>
          <div className={styles.kpiBig} style={{color: jobs.stuck > 0 ? "#ef4444" : "#22c55e"}}>{jobs.stuck}</div>
          <div className={styles.panelSub}>&gt; 10 minutes old</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.kpiLabel}>Avg Processing Time</div>
          <div className={styles.kpiBig}>{jobs.avg_processing_time}s</div>
          <div className={styles.panelSub}>Per completed task</div>
        </div>
      </div>

      <div className={styles.grid2}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>Pipeline Throughput (24h)</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={throughput} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="ts" tickFormatter={ts => new Date(ts).getHours() + "h"} tick={{fontSize: 11, fill: "var(--muted)"}} />
              <YAxis tick={{fontSize: 11, fill: "var(--muted)"}} />
              <Tooltip contentStyle={{background: "var(--surface-2)", border: "none", borderRadius: 8}} labelFormatter={ts => formatDateTime(ts)} />
              <Legend wrapperStyle={{fontSize: 12}} />
              <Bar dataKey="done" name="Successful" stackId="a" fill="#22c55e" />
              <Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className={styles.panel} style={{overflowY: "auto", maxHeight: 340}}>
          <div className={styles.panelTitle}>Downtime Incidents (24h) <span className={styles.panelSub}>{incidents.length} recorded</span></div>
          {incidents.length === 0 ? (
            <div className={styles.panelSub} style={{textAlign: "center", padding: 40}}>No incidents recorded! System is healthy.</div>
          ) : (
            <div style={{display: "flex", flexDirection: "column", gap: 12}}>
              {incidents.map((inc, i) => (
                <div key={i} style={{padding: 12, borderRadius: 8, background: "var(--surface-2)", borderLeft: `4px solid ${inc.resolved ? "#22c55e" : "#ef4444"}`}}>
                  <div style={{display: "flex", justifyContent: "space-between"}}>
                    <strong>{inc.service}</strong>
                    {inc.resolved ? <span style={{fontSize: 12, color: "#22c55e"}}>Resolved</span> : <span style={{fontSize: 12, color: "#ef4444"}}>Ongoing</span>}
                  </div>
                  <div style={{fontSize: 13, color: "var(--muted)", marginTop: 4}}>
                    Duration: {inc.duration_s < 60 ? inc.duration_s + "s" : Math.floor(inc.duration_s/60) + "m"}
                    <br />
                    Started: {formatDateTime(inc.started_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      
      <div className={styles.panel}>
        <div className={styles.panelTitle}>Edge Connectivity (Chrome Extension)</div>
        {extension ? (
          <div className={styles.statusRow}>
            <div style={{display: "flex", gap: 12, alignItems: "center"}}>
              <div className={`${styles.statusDot} ${extension.status === "online" ? styles.bgGreen : extension.status === "idle" ? styles.bgAmber : styles.bgRed}`} />
              <div>
                <strong>{extension.device_name}</strong> (v{extension.version})
                <div className={styles.panelSub}>Last seen: {extension.last_seen_at ? formatDateTime(extension.last_seen_at) : "Never"} ({extension.age_minutes ?? "-"} mins ago)</div>
              </div>
            </div>
            <div className={styles.btnAction} style={{pointerEvents: "none"}}>
              {extension.status.toUpperCase()}
            </div>
          </div>
        ) : (
          <div className={styles.panelSub}>No extension linked.</div>
        )}
      </div>
    </div>
  );
}
