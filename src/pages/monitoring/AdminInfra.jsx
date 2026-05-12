import React, { useEffect, useState } from "react";
import MonitoringTabs from "./MonitoringTabs";
import styles from "./MonitoringStyles.module.css";
import pageLayout from "../../components/system/SystemLayout.module.css";
import { getAdminInfra } from "../../api/auth";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import HistoricalMetricsPanel from "./HistoricalMetricsPanel";

export default function AdminInfra() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getAdminInfra();
        if (res.ok) setData(res);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) return <div className={pageLayout.page}>Loading..</div>;
  if (!data) return <div className={pageLayout.page}>Failed to load infra data</div>;

  const current = data.current;
  const uptime = data.uptime_24h;

  return (
    <div className={pageLayout.page}>
      <MonitoringTabs
        title="Infrastructure & Hardware"
        subtitle="Live server resources, component uptime, and message broker health."
      />

      {/* Zabbix-like historical telemetry prominently at the top */}
      <HistoricalMetricsPanel defaultGroup="resources" availableGroups={["resources", "disk"]} />

      <div className={styles.grid3} style={{ marginTop: 20 }}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>CPU Usage</div>
          <div className={styles.kpiBig}>{current.cpu_pct}%</div>
          <div className={styles.gaugeTrack} style={{ marginTop: 12 }}>
            <div className={`${styles.gaugeFill} ${current.cpu_pct > 80 ? styles.bgRed : styles.bgBlue}`} style={{ width: `${current.cpu_pct}%` }} />
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>RAM Usage</div>
          <div className={styles.kpiBig}>{current.ram_pct}%</div>
          <div className={styles.gaugeMeta} style={{ marginTop: 8 }}>
            <span>{current.ram_used_gb} GB used</span>
            <span>{current.ram_total_gb} GB total</span>
          </div>
          <div className={styles.gaugeTrack}>
            <div className={`${styles.gaugeFill} ${current.ram_pct > 80 ? styles.bgRed : styles.bgPurple}`} style={{ width: `${current.ram_pct}%` }} />
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>Disk Usage</div>
          <div className={styles.kpiBig}>{current.disk_pct}%</div>
          <div className={styles.gaugeMeta} style={{ marginTop: 8 }}>
            <span>{current.disk_used_gb} GB used</span>
            <span>{current.disk_total_gb} GB total</span>
          </div>
          <div className={styles.gaugeTrack}>
            <div className={`${styles.gaugeFill} ${current.disk_pct > 80 ? styles.bgRed : styles.bgGreen}`} style={{ width: `${current.disk_pct}%` }} />
          </div>
        </div>
      </div>

      <div className={styles.grid2}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>Live Service Status</div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>
              <div className={`${styles.statusDot} ${current.redis.ok ? styles.bgGreen : styles.bgRed}`} />
              Redis Broker
            </div>
            <strong style={{ color: current.redis.ok ? "#22c55e" : "#ef4444" }}>{current.redis.ok ? "UP" : "DOWN"}</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>
              <div className={`${styles.statusDot} ${current.worker.ok ? styles.bgGreen : styles.bgRed}`} />
              Celery Worker
            </div>
            <strong style={{ color: current.worker.ok ? "#22c55e" : "#ef4444" }}>{current.worker.ok ? "UP" : "DOWN"}</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>
              <div className={`${styles.statusDot} ${current.database.ok ? styles.bgGreen : styles.bgRed}`} />
              MySQL Database
            </div>
            <strong style={{ color: current.database.ok ? "#22c55e" : "#ef4444" }}>{current.database.ok ? "UP" : "DOWN"}</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>
              <div className={`${styles.statusDot} ${styles.bgGreen}`} />
              API Gateway
            </div>
            <strong style={{ color: "#22c55e" }}>UP</strong>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelTitle}>Redis & Celery Status <span className={styles.panelSub}>Live Live</span></div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>Queue Depth</div>
            <strong style={{ fontSize: "1.1rem" }}>{current.queue_depth} jobs</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>Active Processing</div>
            <strong style={{ fontSize: "1.1rem" }}>{current.worker.active_tasks} tasks</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>Redis Memory</div>
            <strong>{current.redis.mem_mb ?? 0} MB</strong>
          </div>
          <div className={styles.statusRow}>
            <div className={styles.statusLabel}>Redis Clients</div>
            <strong>{current.redis.clients ?? 0} connected</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
