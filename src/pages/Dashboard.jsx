import React from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Dashboard.module.css";
import { trendBars } from "../data/systemMockData";
import { AlertIcon, CheckIcon, DatabaseIcon, EyeIcon, ImageIcon, SearchIcon, ShieldIcon, VideoIcon } from "../components/system/SystemIcons";
import { useNavigate } from "react-router-dom";

// ─── Shared Risk Logic (Internal Mirror) ───────────────────────────────────
function getDashboardMetrics(verdict, score) {
  const v = (verdict || "").toUpperCase();
  const raw = score ?? 0;
  let riskScore = Math.round(raw * 100);

  // 1. Map to consistent labels & tones
  let displayLabel = "Processed";
  let tone = "blue";
  let isThreat = false;

  if (v === "FAKE") {
    displayLabel = "Threat";
    tone = "red";
    isThreat = true;
    riskScore = Math.max(riskScore, 70);
  } else if (v === "REAL") {
    displayLabel = "Verified";
    tone = "green";
    isThreat = false;
    riskScore = Math.min(riskScore, 29);
  } else if (v === "SUSPICIOUS" || (riskScore >= 30 && riskScore <= 69)) {
    displayLabel = "Suspicious";
    tone = "amber";
    isThreat = true;
    if (v === "SUSPICIOUS") riskScore = Math.max(riskScore, 50);
  }

  return { riskScore, displayLabel, tone, isThreat };
}

const toneMap = {
  blue: layout.badgeBlue,
  red: layout.badgeRed,
  amber: layout.badgeAmber,
  cyan: layout.badgeCyan,
  green: layout.badgeGreen
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = React.useState({
    totalScans: 0,
    threatsBlocked: 0,
    trustedMedia: 0,
    activeFingerprints: 3500 
  });
  const [activity, setActivity] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    async function fetchData() {
      try {
        const token = localStorage.getItem("token");
        const [statsRes, activityRes] = await Promise.all([
          fetch("http://localhost:8000/api/analysis/stats", {
            headers: { Authorization: `Bearer ${token}` }
          }),
          fetch("http://localhost:8000/api/analysis", {
            headers: { Authorization: `Bearer ${token}` }
          })
        ]);

        if (statsRes.status === 401 || activityRes.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          navigate("/signin", { replace: true });
          return;
        }

        const statsData = await statsRes.json();
        const activityData = await activityRes.json();

        if (statsData.ok) {
          setStats(prev => ({ ...prev, ...statsData.stats }));
        }
        if (activityData.ok && activityData.data) {
          setActivity(activityData.data.slice(0, 5));
        }
      } catch (err) {
        console.error("Dashboard fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [navigate]);

  const kpis = [
    { title: "Total Media Analyzed", value: stats.totalScans, tone: "blue" },
    { title: "Deepfakes Detected", value: stats.threatsBlocked, tone: "red" },
    { title: "Auto-Blocked", value: stats.threatsBlocked, tone: "amber" },
    { title: "Active Fingerprints", value: stats.activeFingerprints.toLocaleString(), sub: "Global DB", tone: "cyan" },
  ];

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Dashboard</div>
          <p className={layout.pageSub}>
            Central overview of detection activity. Labels and risk levels are now synchronized across the system.
          </p>
        </div>
        <div className={layout.pill}>
          <ShieldIcon className={styles.inlineIcon} />
          <span>System Health: Stable</span>
        </div>
      </section>

      <section className={layout.grid4}>
        {kpis.map((item) => (
          <article key={item.title} className={`${layout.kpiCard} ${styles.kpiCard} ${styles[`tone_${item.tone}`]}`}>
            <div className={styles.kpiTopRow}>
              <span className={styles.kpiLabel}>{item.title}</span>
              <span className={`${layout.badge} ${toneMap[item.tone]}`}>{item.tone === "red" ? "THREAT" : item.tone.toUpperCase()}</span>
            </div>
            <div className={styles.kpiValue}>{item.value}</div>
            {item.sub ? <div className={styles.kpiSub}>{item.sub}</div> : null}
            <div className={styles.kpiGlow} />
          </article>
        ))}
      </section>

      <section className={layout.grid2}>
        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Live Capture Feed</div>
              <div className={layout.panelSub}>Latest media entering the pipeline</div>
            </div>
            <span className={`${layout.badge} ${layout.badgeBlue}`}>Realtime</span>
          </div>

          <div className={styles.feedGrid}>
            {loading ? (
                <div style={{padding: 20}}>Loading...</div>
            ) : activity.length === 0 ? (
                <div style={{padding: 20, opacity: 0.6}}>No recent activity found.</div>
            ) : (
              activity.map((item) => {
                const { isThreat } = getDashboardMetrics(item.verdict, item.score);
                const state = isThreat ? "threat" : "clean";
                return (
                  <div key={item.id} className={`${styles.feedTile} ${styles[`state_${state}`]}`}>
                    <div className={styles.feedMediaIcon}>
                      {item.meta?.media_type === "video" ? <VideoIcon className={styles.tileIcon} /> : <ImageIcon className={styles.tileIcon} />}
                    </div>
                    <div className={styles.feedMeta}>
                      <span>{item.platform || "Web"}</span>
                      <strong>{isThreat ? "Attention Required" : "Validated"}</strong>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </article>

        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Detection Trends</div>
              <div className={layout.panelSub}>Activity across last 24 hours</div>
            </div>
            <span className={`${layout.badge} ${layout.badgeCyan}`}>24h</span>
          </div>
          <div className={styles.chartWrap}>
            <div className={styles.chartArea}>
              {trendBars.map((value, index) => (
                <div key={index} className={styles.chartColumn}>
                  <div className={styles.chartBar} style={{ height: `${value}%` }} />
                </div>
              ))}
            </div>
            <div className={styles.legendRow}>
              <span><span className={`${styles.legendDot} ${styles.legendBlue}`} /> Scans</span>
              <span><span className={`${styles.legendDot} ${styles.legendRed}`} /> Deepfakes</span>
            </div>
          </div>
        </article>
      </section>

      {/* Snapshot Cards */}
      <section className={layout.grid2}>
        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Threat Snapshot</div>
              <div className={layout.panelSub}>State of recently scanned media</div>
            </div>
          </div>
          <div className={styles.metricGrid}>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <AlertIcon className={`${styles.metricIcon} ${layout.toneRed}`} />
              <div>
                <strong>High Risk</strong>
                <span>Action recommended for identified threats</span>
              </div>
            </div>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <EyeIcon className={`${styles.metricIcon} ${layout.toneAmber}`} />
              <div>
                <strong>Review Queue</strong>
                <span>Items pending confirmation</span>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className={layout.panel}>
        <div className={layout.panelHeader}>
          <div className={layout.panelTitle}>Activity Timeline</div>
        </div>
        <div className={styles.timelineList}>
          {loading ? (
             <div style={{padding: 20}}>Loading...</div>
          ) : activity.length === 0 ? (
             <div style={{padding: 20, opacity: 0.6}}>No history available.</div>
          ) : (
            activity.map((item) => {
              const dateObj = new Date(item.created_at);
              const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const { displayLabel, tone } = getDashboardMetrics(item.verdict, item.score);
              const text = `${displayLabel}: ${item.title}`;

              return (
                <div key={item.id} className={styles.timelineRow}>
                  <div className={styles.timelineTime}>{timeStr}</div>
                  <div className={styles.timelineText}>{text}</div>
                  <span className={`${layout.badge} ${toneMap[tone]}`}>{displayLabel}</span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
