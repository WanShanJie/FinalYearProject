import React from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Dashboard.module.css";
import { AlertIcon, EyeIcon, ImageIcon, SearchIcon, ShieldIcon } from "../components/system/SystemIcons";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

import { VERDICT_CONFIG } from "../constants/verdictColors";
import { getVerdictFromScore } from "../utils/riskMapping";

function getDashboardMetrics(verdict, score) {
  const v = (verdict || "").toUpperCase();
  const raw = score ?? 0;
  let riskScore = Math.round(raw * 100);

  // Derive normalized verdict if not explicitly provided or map risk -> verdict
  let normalizedVerdict = v;
  if (!normalizedVerdict || normalizedVerdict === "UNKNOWN" || normalizedVerdict === "PROCESSED") {
    normalizedVerdict = getVerdictFromScore(riskScore);
  } else {
    // If backend provides SUSPICIOUS/etc, ensure case matches config keys
    if (VERDICT_CONFIG[normalizedVerdict] === undefined) {
      normalizedVerdict = getVerdictFromScore(riskScore);
    }
  }

  const config = VERDICT_CONFIG[normalizedVerdict] || VERDICT_CONFIG.INCONCLUSIVE;
  const isThreat = normalizedVerdict === "FAKE" || normalizedVerdict === "SUSPICIOUS";

  return { 
    riskScore, 
    displayLabel: config.label, 
    color: config.color, 
    bg: config.bg, 
    isThreat 
  };
}

const trendRanges = {
  "24h": { key: "24h", label: "24 Hours", totalHours: 24, bucketCount: 12, bucketHours: 2 },
  "7d": { key: "7d", label: "7 Days", totalHours: 24 * 7, bucketCount: 7, bucketHours: 24 },
  "30d": { key: "30d", label: "30 Days", totalHours: 24 * 30, bucketCount: 10, bucketHours: 24 * 3 }
};

function formatTrendLabel(date, rangeKey) {
  if (rangeKey === "24h") {
    return new Intl.DateTimeFormat([], { hour: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date);
}

function formatTimelineTime(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function buildTrendSeries(items, rangeKey) {
  const range = trendRanges[rangeKey] || trendRanges["24h"];
  const now = new Date();
  const totalMs = range.totalHours * 60 * 60 * 1000;
  const bucketMs = range.bucketHours * 60 * 60 * 1000;
  const startTime = new Date(now.getTime() - totalMs);

  const buckets = Array.from({ length: range.bucketCount }, (_, index) => {
    const start = new Date(startTime.getTime() + index * bucketMs);
    const end = new Date(start.getTime() + bucketMs);
    return {
      key: index,
      start,
      end,
      label: formatTrendLabel(start, rangeKey),
      scans: 0,
      flagged: 0
    };
  });

  items.forEach((item) => {
    if (!item?.created_at) return;
    const created = new Date(item.created_at);
    if (created < startTime || created > now) return;

    const bucketIndex = Math.min(
      range.bucketCount - 1,
      Math.max(0, Math.floor((created.getTime() - startTime.getTime()) / bucketMs))
    );

    const bucket = buckets[bucketIndex];
    if (!bucket) return;

    bucket.scans += 1;
    const { isThreat } = getDashboardMetrics(item.verdict, item.score);
    if (isThreat) bucket.flagged += 1;
  });

  const maxValue = Math.max(1, ...buckets.flatMap((bucket) => [bucket.scans, bucket.flagged]));

  return {
    maxValue,
    range,
    buckets: buckets.map((bucket) => ({
      ...bucket,
      scansHeight: Math.max(bucket.scans > 0 ? 8 : 0, Math.round((bucket.scans / maxValue) * 100)),
      flaggedHeight: Math.max(bucket.flagged > 0 ? 8 : 0, Math.round((bucket.flagged / maxValue) * 100))
    }))
  };
}

function DashboardPreview({ analysisId, alt }) {
  const [src, setSrc] = React.useState(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let objectUrl = null;

    async function loadPreview() {
      try {
        const token = localStorage.getItem("token");
        const res = await fetch(`http://localhost:8000/api/analysis/${analysisId}/preview`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Preview fetch failed");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setError(false);
      } catch (err) {
        setError(true);
      }
    }

    if (analysisId) {
      setSrc(null);
      setError(false);
      loadPreview();
    }

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [analysisId]);

  if (error) {
    return (
      <div className={styles.feedPreviewFallback}>
        <ImageIcon className={styles.previewFallbackIcon} />
        <span>No preview</span>
      </div>
    );
  }

  if (!src) {
    return <div className={styles.feedPreviewLoading}>Loading preview...</div>;
  }

  return <img src={src} alt={alt} className={styles.feedPreviewImage} />;
}

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
  const [trendRange, setTrendRange] = React.useState("7d");

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
          setStats((prev) => ({ ...prev, ...statsData.stats }));
        }
        if (activityData.ok && activityData.data) {
          setActivity(activityData.data);
        }
      } catch (err) {
        console.error("Dashboard fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [navigate]);

  const recentActivity = React.useMemo(() => activity.slice(0, 4), [activity]);
  const trendData = React.useMemo(() => buildTrendSeries(activity, trendRange), [activity, trendRange]);

  const trendSummary = React.useMemo(() => {
    let scans = 0;
    let flagged = 0;
    trendData.buckets.forEach((b) => {
      scans += b.scans;
      flagged += b.flagged;
    });
    return { scans, flagged };
  }, [trendData]);

  const threatSnapshot = React.useMemo(() => {
    let fake = 0;
    let suspicious = 0;
    let inconclusive = 0;
    let threatCount = 0;

    activity.forEach((item) => {
      const { displayLabel, isThreat } = getDashboardMetrics(item.verdict, item.score);
      if (isThreat) threatCount++;
      if (displayLabel === "Fake") fake++;
      if (displayLabel === "Suspicious") suspicious++;
      if (displayLabel === "Inconclusive") inconclusive++;
    });

    return { total: threatCount, fake, suspicious, inconclusive };
  }, [activity]);

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

      <div className={styles.rowFull}>
        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Live Capture Feed</div>
              <div className={layout.panelSub}>Recent captured media with direct access to the full analysis record.</div>
            </div>
            <span className={`${layout.badge} ${layout.badgeBlue}`}>Realtime</span>
          </div>

          <div className={styles.feedGrid}>
            {loading ? (
              <div className={styles.panelMessage}>Loading recent captures...</div>
            ) : recentActivity.length === 0 ? (
              <div className={styles.panelMessage}>No recent activity found.</div>
            ) : (
              recentActivity.map((item) => {
                const { displayLabel, color, bg } = getDashboardMetrics(item.verdict, item.score);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.feedCard}
                    onClick={() => navigate(`/media-analysis?analysis_id=${item.id}`)}
                    title="Open this analysis"
                  >
                    <div className={styles.feedPreviewFrame}>
                      <DashboardPreview analysisId={item.id} alt={item.title || "Captured media preview"} />
                    </div>
                    <div className={styles.feedBody}>
                      <div className={styles.feedTopRow}>
                        <span className={styles.feedPlatform}>{item.platform || "Web"}</span>
                        <span className={layout.badge} style={{ color, backgroundColor: bg }}>{displayLabel}</span>
                      </div>
                      <strong className={styles.feedTitle}>{item.title || "Untitled media"}</strong>
                      <div className={styles.feedFooter}>
                        <span className={styles.feedTimestamp}>{formatTimelineTime(item.created_at)}</span>
                        <span className={styles.feedLink}>View details</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </article>
      </div>

      <div className={styles.rowSplit}>
        <article className={`${layout.panel} ${styles.panelLeft}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Detection Trends</div>
              <div className={layout.panelSub}>Monitoring-style view of analysis frequency over time.</div>
            </div>
            <div className={styles.rangeTabs}>
              {Object.values(trendRanges).map((range) => (
                <button
                  key={range.key}
                  type="button"
                  className={`${styles.rangeTab} ${trendRange === range.key ? styles.rangeTabActive : ""}`}
                  onClick={() => setTrendRange(range.key)}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.trendSummaryCards}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Total Analyses</div>
              <div className={styles.summaryValueBlue}>{trendSummary.scans}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Flagged Detections</div>
              <div className={styles.summaryValueRed}>{trendSummary.flagged}</div>
            </div>
          </div>

          <div className={styles.chartContainer}>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={trendData.buckets} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorScans" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorFlagged" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" stroke="#475569" fontSize={12} tickMargin={8} minTickGap={20} />
                <YAxis stroke="#475569" fontSize={12} tickFormatter={(val) => Math.round(val)} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1e293b", borderColor: "#334155", borderRadius: "8px", color: "#f8fafc" }}
                  itemStyle={{ color: "#e2e8f0" }}
                />
                <Area type="monotone" dataKey="scans" name="Total Analyses" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorScans)" />
                <Area type="monotone" dataKey="flagged" name="Flagged" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#colorFlagged)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className={`${layout.panel} ${styles.panelRight}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Threat Snapshot</div>
              <div className={layout.panelSub}>State of recently scanned media</div>
            </div>
          </div>
          
          <div className={styles.snapshotContainer}>
            <div className={styles.snapshotTotalCard}>
              <span className={styles.snapshotLabel}>Total Threats</span>
              <span className={styles.snapshotTotalValue}>{threatSnapshot.total || stats.threatsBlocked || 0}</span>
            </div>

            <div className={styles.snapshotBreakdown}>
              <div className={styles.breakdownRow}>
                <div className={styles.breakdownLabel}>
                  <span className={`${styles.legendDot} ${styles.legendRed}`} /> Fake
                </div>
                <div className={styles.breakdownValue}>{threatSnapshot.fake}</div>
              </div>
              <div className={styles.breakdownRow}>
                <div className={styles.breakdownLabel}>
                  <span className={`${styles.legendDot} ${styles.legendAmber}`} /> Suspicious
                </div>
                <div className={styles.breakdownValue}>{threatSnapshot.suspicious}</div>
              </div>
              <div className={styles.breakdownRow}>
                <div className={styles.breakdownLabel}>
                  <span className={`${styles.legendDot} ${styles.legendBlue}`} /> Inconclusive
                </div>
                <div className={styles.breakdownValue}>{threatSnapshot.inconclusive}</div>
              </div>
            </div>
          </div>
        </article>
      </div>

      <div className={styles.rowFull}>
        <article className={layout.panel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Activity Timeline</div>
              <div className={layout.panelSub}>Latest analysis actions recorded by the system</div>
            </div>
          </div>
          <div className={styles.timelineList}>
            {loading ? (
              <div className={styles.panelMessage}>Loading timeline...</div>
            ) : activity.length === 0 ? (
              <div className={styles.panelMessage}>No activity found.</div>
            ) : (
              activity.slice(0, 5).map((item) => {
                const { displayLabel, color, bg } = getDashboardMetrics(item.verdict, item.score);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.timelineRowButton}
                    onClick={() => navigate(`/media-analysis?analysis_id=${item.id}`)}
                  >
                    <div className={styles.timelineRow}>
                      <div className={styles.timelinePreviewClip}>
                         <DashboardPreview analysisId={item.id} alt="Preview" />
                      </div>
                      <div className={styles.timelineText}>
                        <strong>{item.title || "Untitled media"}</strong>
                        <div className={styles.timelineTime}>{formatTimelineTime(item.created_at)}</div>
                      </div>
                      <span className={layout.badge} style={{ color, backgroundColor: bg }}>{displayLabel}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
