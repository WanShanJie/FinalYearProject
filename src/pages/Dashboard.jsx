import React from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Dashboard.module.css";
import { activityTimeline, dashboardKpis, liveFeed, trendBars } from "../data/systemMockData";
import { AlertIcon, CheckIcon, DatabaseIcon, EyeIcon, ImageIcon, SearchIcon, ShieldIcon, VideoIcon, SyncIcon } from "../components/system/SystemIcons";
import { useNavigate } from "react-router-dom";

const toneMap = {
  blue: layout.badgeBlue,
  red: layout.badgeRed,
  amber: layout.badgeAmber,
  cyan: layout.badgeCyan,
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = React.useState({
    totalScans: 0,
    threatsBlocked: 0,
    trustedMedia: 0,
    activeFingerprints: 3500 // placeholder for global DB
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
          setActivity(activityData.data.slice(0, 5)); // show only recent 5
        }
      } catch (err) {
        console.error("Dashboard fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const kpis = [
    { title: "Total Media Analyzed", value: stats.totalScans, tone: "blue" },
    { title: "Deepfakes Detected", value: stats.threatsBlocked, tone: "red" },
    { title: "Auto-Blocked", value: stats.threatsBlocked, tone: "amber" }, // assuming auto-block matches threats for now
    { title: "Active Fingerprints", value: stats.activeFingerprints.toLocaleString(), sub: "Global DB", tone: "cyan" },
  ];
  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Dashboard</div>
          <p className={layout.pageSub}>
            Central overview of detection activity, live media intake, and recent moderation actions. The layout now matches the system shell, so header and sidebar stay fixed when users navigate.
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
              <span className={`${layout.badge} ${toneMap[item.tone]}`}>{item.tone.toUpperCase()}</span>
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
              <div className={layout.panelSub}>Recent media entering the verification pipeline</div>
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
                const isFake = item.verdict === "FAKE" || item.verdict === "SUSPICIOUS";
                const state = isFake ? "threat" : "clean";
                return (
                  <div key={item.id} className={`${styles.feedTile} ${styles[`state_${state}`]}`}>
                    <div className={styles.feedMediaIcon}>
                      {item.meta?.media_type === "video" ? <VideoIcon className={styles.tileIcon} /> : <ImageIcon className={styles.tileIcon} />}
                    </div>
                    <div className={styles.feedMeta}>
                      <span>{item.platform || "Unknown"}</span>
                      <strong>{isFake ? "Threat flagged" : "Clean"}</strong>
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
              <div className={layout.panelSub}>Detections across the last 24 hours</div>
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

      <section className={layout.grid2}>
        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Threat Exposure Snapshot</div>
              <div className={layout.panelSub}>How current detections break down by category</div>
            </div>
          </div>

          <div className={styles.metricGrid}>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <AlertIcon className={`${styles.metricIcon} ${layout.toneRed}`} />
              <div>
                <strong>High Risk</strong>
                <span>12 media items require immediate action</span>
              </div>
            </div>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <EyeIcon className={`${styles.metricIcon} ${layout.toneAmber}`} />
              <div>
                <strong>Analyst Queue</strong>
                <span>7 items pending manual review</span>
              </div>
            </div>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <CheckIcon className={`${styles.metricIcon} ${layout.toneGreen}`} />
              <div>
                <strong>Trusted Media</strong>
                <span>128 items cleared automatically today</span>
              </div>
            </div>
            <div className={layout.metricCard + " " + styles.metricCard}>
              <DatabaseIcon className={`${styles.metricIcon} ${layout.toneCyan}`} />
              <div>
                <strong>Fingerprint DB</strong>
                <span>3,500 active entries in synchronized storage</span>
              </div>
            </div>
          </div>
        </article>

        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Review Focus</div>
              <div className={layout.panelSub}>Priority guidance for moderation team</div>
            </div>
          </div>

          <div className={styles.focusStack}>
            <div className={styles.focusCard}>
              <SearchIcon className={`${styles.metricIcon} ${layout.toneBlue}`} />
              <div>
                <strong>Watch manipulated speech clips</strong>
                <p>Face synthesis artifacts are rising in short-form political video uploads.</p>
              </div>
            </div>
            <div className={styles.focusCard}>
              <ShieldIcon className={`${styles.metricIcon} ${layout.toneCyan}`} />
              <div>
                <strong>Global policies synchronized</strong>
                <p>Community threat database is aligned with local blocklist rules and settings.</p>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className={layout.panel}>
        <div className={layout.panelHeader}>
          <div>
            <div className={layout.panelTitle}>Activity Timeline</div>
            <div className={layout.panelSub}>Recent actions across blocking, review, and verification</div>
          </div>
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
              const isFake = item.verdict === "FAKE" || item.verdict === "SUSPICIOUS";
              const tag = isFake ? "Threat" : (item.verdict === "REAL" ? "Verified" : "Processed");
              const tone = isFake ? "red" : (item.verdict === "REAL" ? "green" : "blue");
              const text = `${isFake ? "Detected threat" : "Processed media"}: ${item.title}`;

              return (
                <div key={item.id} className={styles.timelineRow}>
                  <div className={styles.timelineTime}>{timeStr}</div>
                  <div className={styles.timelineText}>{text}</div>
                  <span className={`${layout.badge} ${tone === "red" ? layout.badgeRed : tone === "green" ? layout.badgeGreen : tone === "amber" ? layout.badgeAmber : tone === "cyan" ? layout.badgeCyan : layout.badgeBlue}`}>{tag}</span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
