import React, { useState, useEffect, useCallback } from "react";
import styles from "./AdminMonitoring.module.css";
import { getAdminStats, getAdminLogs } from "../api/auth";
import {
  ActivityIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  SyncIcon,
  MonitorIcon,
} from "../components/system/SystemIcons";

// ── Verdict chip ────────────────────────────────────────────────────────────
const VERDICT_CHIP = {
  REAL:        styles.chipReal,
  FAKE:        styles.chipFake,
  SUSPICIOUS:  styles.chipSuspicious,
  INCONCLUSIVE:styles.chipInconclusive,
};

function VerdictChip({ verdict }) {
  const cls = VERDICT_CHIP[verdict] || styles.chipPending;
  return <span className={`${styles.chip} ${cls}`}>{verdict || "PENDING"}</span>;
}

// ── Status cell ─────────────────────────────────────────────────────────────
function StatusCell({ status }) {
  const dotCls =
    status === "DONE"  ? styles.dotDone  :
    status === "ERROR" ? styles.dotError :
                         styles.dotPending;
  return (
    <span className={styles.statusCell}>
      <span className={`${styles.dot} ${dotCls}`} />
      {status || "PENDING"}
    </span>
  );
}

// ── Verdict breakdown bar ────────────────────────────────────────────────────
const VERDICT_BAR_CLS = {
  REAL:        styles.barReal,
  FAKE:        styles.barFake,
  SUSPICIOUS:  styles.barSuspicious,
  INCONCLUSIVE:styles.barInconclusive,
  PENDING:     styles.barPending,
};

const VERDICT_ORDER = ["FAKE", "SUSPICIOUS", "REAL", "INCONCLUSIVE", "PENDING"];

function VerdictBreakdown({ breakdown, total }) {
  if (!breakdown || total === 0) {
    return <div className={styles.muted}>No detections yet.</div>;
  }
  return (
    <div className={styles.verdictList}>
      {VERDICT_ORDER.filter((v) => breakdown[v] > 0).map((v) => {
        const count = breakdown[v] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={v} className={styles.verdictRow}>
            <div className={styles.verdictMeta}>
              <span className={styles.verdictLabel}>{v}</span>
              <span className={styles.verdictCount}>{count} ({pct}%)</span>
            </div>
            <div className={styles.barTrack}>
              <div
                className={`${styles.barFill} ${VERDICT_BAR_CLS[v] || styles.barPending}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Platform breakdown ───────────────────────────────────────────────────────
const PLATFORM_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#22d3ee", "#a78bfa", "#94a3b8"];

function PlatformBreakdown({ logs }) {
  const counts = {};
  for (const l of logs) {
    const p = l.platform || "Direct Upload";
    counts[p] = (counts[p] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;

  if (sorted.length === 0) {
    return <div className={styles.muted}>No data yet.</div>;
  }
  return (
    <div className={styles.platformList}>
      {sorted.map(([name, count], i) => (
        <div key={name} className={styles.platformRow}>
          <span
            className={styles.platformDot}
            style={{ background: PLATFORM_COLORS[i % PLATFORM_COLORS.length] }}
          />
          <span className={styles.platformName}>{name}</span>
          <div className={`${styles.barTrack} ${styles.platformBar}`}>
            <div
              className={styles.barFill}
              style={{
                width: `${Math.round((count / max) * 100)}%`,
                background: PLATFORM_COLORS[i % PLATFORM_COLORS.length],
              }}
            />
          </div>
          <span className={styles.platformCount}>{count}</span>
        </div>
      ))}
    </div>
  );
}

// ── Timestamp formatter ──────────────────────────────────────────────────────
function formatTs(ts) {
  if (!ts) return "—";
  try {
    return new Intl.DateTimeFormat([], {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(new Date(ts));
  } catch {
    return ts;
  }
}

// ── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, tone, Icon }) {
  return (
    <div className={`${styles.kpiCard} ${styles[tone]}`}>
      <div className={styles.kpiTop}>
        <span className={styles.kpiLabel}>{label}</span>
        {Icon && <Icon className={styles.kpiIcon} />}
      </div>
      <div className={styles.kpiValue}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
      <div className={styles.kpiGlow} />
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function AdminMonitoring() {
  const [stats, setStats]     = useState(null);
  const [logs, setLogs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, logsRes] = await Promise.all([
        getAdminStats(),
        getAdminLogs(20),
      ]);
      if (statsRes.ok) setStats(statsRes.stats);
      if (logsRes.ok)  setLogs(logsRes.data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err.message || "Failed to load monitoring data.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-refresh every 30 s
  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const total    = stats?.total_requests  ?? 0;
  const success  = stats?.success_count   ?? 0;
  const failures = stats?.failure_count   ?? 0;
  const avgTime  = stats?.avg_processing_time ?? 0;
  const rate     = stats?.success_rate    ?? 0;

  return (
    <div>
      {/* ── Page header ──────────────────────────────── */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>System Monitoring</h1>
          <p className={styles.pageSubtitle}>
            Live metrics across all users — auto-refreshes every 30 s
            {lastRefresh && ` · Last updated ${formatTs(lastRefresh.toISOString())}`}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          <SyncIcon className={styles.refreshIcon} />
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* ── Error state ──────────────────────────────── */}
      {error && (
        <div className={`${styles.stateBox} ${styles.error}`}>{error}</div>
      )}

      {/* ── KPI cards ────────────────────────────────── */}
      <div className={styles.kpiGrid}>
        <KpiCard
          label="Total Requests"
          value={total}
          sub={`${success} succeeded · ${failures} failed`}
          tone="blue"
          Icon={ActivityIcon}
        />
        <KpiCard
          label="Success Rate"
          value={`${rate}%`}
          sub="Availability metric"
          tone={rate >= 90 ? "green" : "amber"}
          Icon={CheckCircleIcon}
        />
        <KpiCard
          label="Avg Processing Time"
          value={`${avgTime}s`}
          sub="Completed analyses only"
          tone="amber"
          Icon={ClockIcon}
        />
        <KpiCard
          label="Failed Requests"
          value={failures}
          sub={total > 0 ? `${(100 - rate).toFixed(1)}% error rate` : "No errors yet"}
          tone={failures > 0 ? "red" : "green"}
          Icon={XCircleIcon}
        />
      </div>

      {/* ── Verdict breakdown + Platform split ───────── */}
      <div className={styles.rowSplit}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Verdict Breakdown</span>
            <span className={styles.panelBadge}>{total} total</span>
          </div>
          <div className={styles.panelBody}>
            {loading && !stats
              ? <div className={styles.stateBox}>Loading…</div>
              : <VerdictBreakdown breakdown={stats?.verdict_breakdown} total={total} />
            }
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Platform Distribution</span>
            <span className={styles.panelBadge}>{logs.length} logs</span>
          </div>
          <div className={styles.panelBody}>
            {loading && logs.length === 0
              ? <div className={styles.stateBox}>Loading…</div>
              : <PlatformBreakdown logs={logs} />
            }
          </div>
        </div>
      </div>

      {/* ── Detection logs table ─────────────────────── */}
      <div className={styles.logsPanel}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>
            <MonitorIcon style={{ width: 16, height: 16, marginRight: 8, verticalAlign: "middle" }} />
            Detection Logs
          </span>
          <span className={styles.panelBadge}>Latest {logs.length}</span>
        </div>

        {loading && logs.length === 0 ? (
          <div className={styles.stateBox}>Loading logs…</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>User</th>
                  <th>Platform / Source</th>
                  <th>Video ID / URL</th>
                  <th>Verdict</th>
                  <th>Processing Time</th>
                  <th>Status</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className={styles.emptyCell}>
                      No detection logs found. Run a detection to see data here.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.request_id}>
                      <td className={styles.muted}>#{log.request_id}</td>
                      <td className={styles.muted}>{log.user_id}</td>
                      <td>{log.platform || "Direct Upload"}</td>
                      <td>
                        <span className={styles.videoId} title={log.video_id}>
                          {log.video_id || "—"}
                        </span>
                      </td>
                      <td><VerdictChip verdict={log.verdict} /></td>
                      <td className={styles.muted}>
                        {log.processing_time != null ? `${log.processing_time}s` : "—"}
                      </td>
                      <td><StatusCell status={log.status} /></td>
                      <td className={styles.muted}>{formatTs(log.timestamp)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
