import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { AlertIcon, ImageIcon } from "../components/system/SystemIcons";
import { buildReasoning, getDisplayMetrics, getPolicyAction } from "./mediaAnalysisShared";

function RiskRing({ riskScore, color }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (riskScore / 100) * circumference;

  return (
    <div className={styles.confidenceRing}>
      <svg className={styles.ringSvg} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} stroke="rgba(0,0,0,0.3)" strokeWidth="6" fill="transparent" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          stroke={color}
          strokeWidth="6"
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className={styles.confidenceInner}>
        <span style={{ color }}>{riskScore}%</span>
        <small>risk</small>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict, color, bg }) {
  return (
    <span
      className={layout.badge}
      style={{
        color,
        backgroundColor: bg,
        border: `1px solid ${color}44`,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        fontWeight: 800,
        padding: "6px 12px",
        fontSize: "0.72rem"
      }}
    >
      {verdict}
    </span>
  );
}

export default function MediaAnalysisDetail() {
  const navigate = useNavigate();
  const { analysisId } = useParams();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchAnalysis() {
      try {
        const token = localStorage.getItem("token");
        const res = await fetch(`http://localhost:8000/api/analysis/${analysisId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (res.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          navigate("/signin", { replace: true });
          return;
        }

        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          throw new Error(json.detail || json.message || "Unable to load this analysis record.");
        }

        setItem(json.data);
        setError("");
      } catch (err) {
        setError(err.message || "Unable to load this analysis record.");
      } finally {
        setLoading(false);
      }
    }

    fetchAnalysis();
  }, [analysisId, navigate]);

  if (loading) {
    return (
      <div className={layout.page}>
        <section className={layout.heroPanel}>
          <div className={layout.pageTitle}>Loading Detection Details...</div>
        </section>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className={layout.page}>
        <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
          <div>
            <div className={layout.pageTitle}>Detection Details</div>
            <p className={layout.pageSub}>Open one record at a time from the detection list.</p>
          </div>
          <button type="button" className={styles.backButton} onClick={() => navigate("/media-analysis")}>
            Back to List
          </button>
        </section>
        <section className={styles.feedbackError}>
          {error || "Analysis record not found."}
        </section>
      </div>
    );
  }

  const metrics = getDisplayMetrics(item.verdict, item.score);
  const policy = getPolicyAction(metrics.displayVerdictKey);
  const reasoning = buildReasoning(item, metrics);

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Detection Details</div>
          <p className={layout.pageSub}>
            Review the selected media record in a dedicated detail page.
          </p>
        </div>
        <button type="button" className={styles.backButton} onClick={() => navigate("/media-analysis")}>
          Back to List
        </button>
      </section>

      <section className={styles.detailPageShell}>
        <article className={`${layout.stackCard} ${styles.detailTopCard}`}>
          <div className={styles.detailHeader}>
            <div>
              <div className={styles.detailTitle}>{item.title || "Untitled media"}</div>
              <div className={styles.detailSub}>{item.platform || "Web"} - {item.page_url || "Unknown source"}</div>
            </div>
            <div className={styles.headerRight}>
              <div className={styles.verdictBlock}>
                <VerdictBadge verdict={metrics.displayVerdict} color={metrics.verdictColor} bg={metrics.verdictBg} />
                <div className={styles.riskLevelBadge} style={{ color: metrics.scoreColor, backgroundColor: metrics.scoreBg }}>
                  {metrics.riskLevel}
                </div>
              </div>
              <RiskRing riskScore={metrics.riskScore} color={metrics.scoreColor} />
            </div>
          </div>

          <div className={styles.riskStrip}>
            <div className={styles.riskStripItem}>
              <span>MANIPULATION RISK</span>
              <strong style={{ color: metrics.scoreColor }}>{metrics.riskScore}%</strong>
            </div>
            <div className={styles.riskStripItem}>
              <span>RISK LEVEL</span>
              <strong style={{ color: metrics.scoreColor }}>{metrics.riskLevel}</strong>
            </div>
            <div className={styles.riskStripItem}>
              <span>VERDICT</span>
              <strong style={{ color: metrics.verdictColor }}>{metrics.displayVerdict}</strong>
            </div>
            <div className={styles.riskStripItem}>
              <span>PLATFORM</span>
              <strong style={{ color: "var(--text)" }}>{item.platform || "unknown"}</strong>
            </div>
          </div>

          <div className={styles.previewArea}>
            <div className={styles.previewCanvas}>
              <AuthImage analysisId={item.id} alt="Captured preview" />
            </div>
            <div className={styles.actionRail}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => item.page_url && window.open(item.page_url, "_blank")}
                disabled={!item.page_url}
              >
                Open Source
              </button>
              <button type="button" className={styles.secondaryAction}>Export Report</button>
            </div>
          </div>
        </article>

        <div className={styles.infoGrid}>
          <article className={`${layout.card} ${styles.metadataCard}`}>
            <div className={layout.panelHeader}>
              <div>
                <div className={layout.panelTitle}>Metadata</div>
                <div className={layout.panelSub}>Technical attributes</div>
              </div>
            </div>
            <div className={styles.metadataGrid}>
              <MetaRow label="Type" value={item.meta?.media_type || "Unknown"} />
              <MetaRow label="Captured" value={item.created_at ? new Date(item.created_at).toLocaleString() : "Unknown"} />
              <MetaRow label="Scan ID" value={item.id} />
              <MetaRow label="Frames" value={item.meta?.frame_count || "N/A"} />
              <MetaRow label="Mode" value={item.meta?.capture_mode || "N/A"} />
            </div>
          </article>

          <article className={`${layout.card} ${styles.explanationCard}`}>
            <div className={layout.panelHeader}>
              <div>
                <div className={layout.panelTitle}>Why This Result</div>
                <div className={layout.panelSub}>Plain-language explanation of the verdict</div>
              </div>
              <AlertIcon className={styles.smallIcon} style={{ color: metrics.verdictColor }} />
            </div>

            <div className={styles.signalsBlock} style={{ marginTop: 0 }}>
              <div className={styles.signalsLabel}>Summary</div>
              <p className={styles.summaryText}>{reasoning.summary}</p>
            </div>

            <div className={styles.signalsBlock}>
              <div className={styles.signalsLabel}>What Affected the Result</div>
              <ul className={styles.reasonList}>
                {reasoning.highlights.map((signal, index) => <li key={index}>{signal}</li>)}
              </ul>
            </div>

            <div className={styles.signalsBlock}>
              <div className={styles.signalsLabel}>Simple Interpretation</div>
              <p className={styles.summaryText}>{reasoning.interpretation}</p>
            </div>

            <div className={styles.policyBox} style={{ borderColor: policy.color, backgroundColor: policy.bg, color: policy.color, opacity: 0.9 }}>
              <strong style={{ color: policy.color }}>Recommended Policy: </strong>
              <span style={{ color: "var(--text)" }}>{policy.text}</span>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}

function MetaRow({ label, value }) {
  return (
    <div className={styles.metaRow}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AuthImage({ analysisId, alt }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl = null;

    async function loadImg() {
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
      loadImg();
    }

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [analysisId]);

  if (error) {
    return (
      <div className={styles.errorThumb}>
        <ImageIcon className={styles.previewIcon} />
        <span className={styles.loadingText}>Preview unavailable</span>
      </div>
    );
  }

  if (!src) {
    return <span className={styles.loadingText}>Loading...</span>;
  }

  return <img src={src} alt={alt} className={styles.previewImg} />;
}
