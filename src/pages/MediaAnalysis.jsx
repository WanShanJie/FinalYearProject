import React, { useMemo, useState, useEffect } from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { AlertIcon, CheckIcon, ImageIcon, SearchIcon, VideoIcon } from "../components/system/SystemIcons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { VERDICT_CONFIG } from "../constants/verdictColors";
import { getVerdictFromScore } from "../utils/riskMapping";

// ─── Shared Risk & Presentation Logic ───────────────────────────────────────
export function getDisplayMetrics(backendVerdict, rawScore) {
  const v = (backendVerdict || "").toUpperCase();
  const raw = rawScore ?? 0;
  let riskScore = Math.round(raw * 100);

  // 1. Standardize Final Verdict
  let mappedVerdict = v;
  if (!mappedVerdict || mappedVerdict === "UNKNOWN" || mappedVerdict === "PROCESSED") {
    mappedVerdict = getVerdictFromScore(riskScore);
  } else if (!VERDICT_CONFIG[mappedVerdict]) {
    mappedVerdict = getVerdictFromScore(riskScore);
  }

  // 2. Standardize Risk Level & Score strictly by model score
  const scoreVerdict = getVerdictFromScore(riskScore);
  let riskLevel = "Medium Risk";
  if (scoreVerdict === "FAKE") riskLevel = "High Risk";
  else if (scoreVerdict === "REAL") riskLevel = "Low Risk";

  if (mappedVerdict === "REAL") {
    riskLevel = (riskScore < 30) ? "Low Risk" : "Legitimate"; 
  }

  const verdictConfig = VERDICT_CONFIG[mappedVerdict] || VERDICT_CONFIG.INCONCLUSIVE;
  const scoreConfig = VERDICT_CONFIG[scoreVerdict] || VERDICT_CONFIG.INCONCLUSIVE;

  return { 
    riskScore, 
    displayVerdictKey: mappedVerdict,
    displayVerdict: verdictConfig.label, 
    riskLevel, 
    scoreColor: scoreConfig.color, 
    scoreBg: scoreConfig.bg,
    verdictColor: verdictConfig.color,
    verdictBg: verdictConfig.bg
  };
}

function getPolicyAction(displayVerdictKey) {
  if (displayVerdictKey === "FAKE") {
    return { text: "Warning recommended. Block or restrict sharing of this content.", color: VERDICT_CONFIG.FAKE.color, bg: VERDICT_CONFIG.FAKE.bg };
  }
  if (displayVerdictKey === "REAL") {
    return { text: "No immediate action required. The content was classified as authentic by the final decision logic.", color: VERDICT_CONFIG.REAL.color, bg: VERDICT_CONFIG.REAL.bg };
  }
  return { text: "Review carefully before trusting or sharing. Mixed signals detected.", color: VERDICT_CONFIG.SUSPICIOUS.color, bg: VERDICT_CONFIG.SUSPICIOUS.bg };
}

function buildReasoning(item, metrics) {
  const decision = item.meta?.decision || {};
  const qgate = item.meta?.quality_gate || {};
  const stability = item.meta?.stability || {};
  const altfreezing = item.meta?.altfreezing || {};
  const { displayVerdict, riskScore } = metrics;

  const rawModelScore = decision.raw_score != null ? Math.round(decision.raw_score * 100) : null;
  const reasonCode = decision.reason || "";
  const isOverride = reasonCode.includes("override");
  const isTalkingHeadOverride = reasonCode === "stable_bright_talking_head_override";

  // 1. Reason Summary
  let summary = decision.final_explanation || "";
  if (!summary) {
    if (isTalkingHeadOverride) {
      summary = `The raw model score was high, but the final result was classified as REAL because the analyzed video showed strong sequence stability, consistent face tracking, and passed the quality checks. The content matched a stable talking-head interview pattern, so the system applied an override to avoid a false fake classification.`;
    } else if (metrics.displayVerdictKey === "REAL") {
      summary = `Analysis found no significant evidence of digital manipulation. The content appears authentic based on frame-by-frame AI inspection.`;
    } else if (metrics.displayVerdictKey === "FAKE") {
      summary = `The AI model detected strong indicators of digital manipulation across multiple frames. This content is likely synthetically generated or altered.`;
    } else {
      summary = `The analysis returned mixed or inconclusive signals. Evidence quality may have been too low for a definitive verdict.`;
    }
  }

  // 2. Score Interpretation
  let interpretation = "";
  if (isOverride && metrics.displayVerdictKey === "REAL" && riskScore >= 70) {
    interpretation = `The model produced a high suspicious score (about ${riskScore}%), which means some visual patterns looked unusual to the model. However, this score was reinterpreted using sequence stability and quality evidence before the final verdict was assigned.`;
  } else if (metrics.displayVerdictKey === "FAKE") {
    interpretation = `The model returned a suspiciously high score (${riskScore}%), confirming the presence of synthetic artifacts or deepfake manipulation patterns.`;
  } else if (metrics.displayVerdictKey === "REAL") {
    interpretation = `The model returned a low risk score (${riskScore}%), indicating that the visual patterns align with natural, untampered media.`;
  } else {
    interpretation = `The model returned a baseline score of ${riskScore}%, which falls into the uncertain range.`;
  }

  // 3. Key Signals
  const signals = [];
  if (stability.stable) signals.push(`Stable face tracking across the analyzed sequence`);
  if (stability.avg_iou != null && stability.avg_iou > 0.8) signals.push(`Strong overlap consistency between detected face regions (${Math.round(stability.avg_iou*100)}%)`);
  if (stability.max_centre_drift != null && stability.max_centre_drift < 0.05) signals.push(`Very low centre drift between frames`);
  if (stability.size_consistency != null && stability.size_consistency > 0.8) signals.push(`High size consistency across the sequence`);
  if (qgate.pass) signals.push(`Quality gate passed with sufficient usable frames`);
  if (altfreezing.high_frame_count != null && altfreezing.high_frame_count > 0) signals.push(`${altfreezing.high_frame_count} frames flagged with elevated signals by the model`);

  if (signals.length === 0) {
    if (metrics.displayVerdictKey === "REAL") signals.push("No repeated frame artifacts detected", "Facial consistency within expected natural range");
    else if (metrics.displayVerdictKey === "FAKE") signals.push("High model confidence on multiple frames", "Anomalous facial patterns detected");
    else signals.push("Mixed signals across frame analysis", "Insufficient evidence for definitive conclusion");
  }

  // 4. Decision Logic / Override
  let logic = "";
  if (isTalkingHeadOverride) {
    logic = `The system applied the rule: stable_bright_talking_head_override, which reduced the likelihood of false detection for a stable interview-style video with strong temporal consistency.`;
  } else if (reasonCode) {
    logic = `The system applied the decision rule: ${reasonCode}.`;
  } else {
    logic = `The verdict was derived directly from the model score falling into the ${metrics.displayVerdictKey} threshold range.`;
  }

  return { summary, interpretation, signals, logic };
}

// ─── Components ─────────────────────────────────────────────────────────────

function RiskRing({ riskScore, color }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (riskScore / 100) * circumference;

  return (
    <div className={styles.confidenceRing}>
      <svg className={styles.ringSvg} viewBox="0 0 100 100">
        {/* Track */}
        <circle 
          cx="50" cy="50" r={radius} 
          stroke="rgba(0,0,0,0.3)" 
          strokeWidth="6" 
          fill="transparent" 
        />
        {/* Progress */}
        <circle 
          cx="50" cy="50" r={radius} 
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

// ─── Main Component ──────────────────────────────────────────────────────────
export default function MediaAnalysis() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const token = localStorage.getItem("token");
        const res = await fetch("http://localhost:8000/api/analysis", {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          navigate("/signin", { replace: true });
          return;
        }
        const json = await res.json();
        if (json.ok) {
          setDetections(json.data);
          if (json.data.length > 0) {
            const requestedId = Number(searchParams.get("analysis_id"));
            const matching = requestedId ? json.data.find((item) => Number(item.id) === requestedId) : null;
            setSelectedId(matching ? matching.id : json.data[0].id);
          }
        }
      } catch (err) {
        console.error("MediaAnalysis fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [navigate, searchParams]);

  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return detections;
    return detections.filter((item) =>
      [item.title, item.platform, item.verdict, item.page_url].join(" ").toLowerCase().includes(value)
    );
  }, [query, detections]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query]);

  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const paginatedItems = filteredItems.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const selected = useMemo(() => {
    return detections.find((item) => item.id === selectedId) || detections[0];
  }, [selectedId, detections]);

  if (loading) {
    return (
      <div className={layout.page}>
        <section className={layout.heroPanel}>
          <div className={layout.pageTitle}>Loading Media Analysis...</div>
        </section>
      </div>
    );
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Media Analysis</div>
          <p className={layout.pageSub}>
            Review detections associated with your account. Each result is synchronized between verdict, risk level, and reasoning.
          </p>
        </div>
        <div className={layout.pill}>
          <SearchIcon className={styles.smallIcon} />
          <span>Detailed review mode</span>
        </div>
      </section>

      {detections.length === 0 ? (
        <section className={layout.panel} style={{ textAlign: "center", padding: "60px 20px" }}>
          <div className={layout.panelTitle}>No Detections Found</div>
          <p className={layout.pageSub} style={{ margin: "12px auto" }}>You haven't analyzed any media yet.</p>
        </section>
      ) : (
        <section className={styles.analysisGrid}>
          <article className={`${layout.tableCard} ${styles.listPanel}`}>
            <div className={styles.listHeader}>
              <div>
                <div className={layout.panelTitle}>Detection List</div>
                <div className={layout.panelSub}>{filteredItems.length} items found</div>
              </div>
              <div className={styles.searchBox}>
                <SearchIcon className={styles.searchIcon} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search detections..."
                  className={styles.searchInput}
                />
              </div>
            </div>

            <div className={styles.listBody}>
              {paginatedItems.map((item) => {
                const metrics = getDisplayMetrics(item.verdict, item.score);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={item.id === (selected?.id) ? `${styles.mediaRow} ${styles.mediaRowActive}` : styles.mediaRow}
                  >
                    <div className={styles.thumb}>
                      <AuthImage 
                        analysisId={item.id} 
                        alt={item.title} 
                        className={styles.listThumbImg}
                        showLoader={false}
                      />
                    </div>
                    <div className={styles.mediaMeta}>
                      <strong>{item.title}</strong>
                      <span>{item.platform || "Web"} · {new Date(item.created_at).toLocaleDateString()}</span>
                      <span className={styles.riskLabel} style={{ color: metrics.scoreColor }}>{metrics.riskLevel} · {metrics.riskScore}%</span>
                    </div>
                    <VerdictBadge verdict={metrics.displayVerdict} color={metrics.verdictColor} bg={metrics.verdictBg} />
                  </button>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className={styles.pagination}>
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(p => p - 1)}
                  className={styles.pageBtn}
                >
                  Prev
                </button>
                <div className={styles.pageInfo}>
                  Page <strong>{currentPage}</strong> of {totalPages}
                </div>
                <button 
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage(p => p + 1)}
                  className={styles.pageBtn}
                >
                  Next
                </button>
              </div>
            )}
          </article>

          {selected && (() => {
            const metrics = getDisplayMetrics(selected.verdict, selected.score);
            const policy = getPolicyAction(metrics.displayVerdictKey);
            const reasoning = buildReasoning(selected, metrics);

            return (
              <section className={styles.detailColumn}>
                <article className={`${layout.stackCard} ${styles.detailTopCard}`}>
                  <div className={styles.detailHeader}>
                    <div>
                      <div className={styles.detailTitle}>{selected.title}</div>
                      <div className={styles.detailSub}>{selected.platform} · {selected.page_url}</div>
                    </div>
                    <div className={styles.headerRight}>
                      <div className={styles.verdictBlock}>
                        <VerdictBadge verdict={metrics.displayVerdict} color={metrics.verdictColor} bg={metrics.verdictBg} />
                        <div className={styles.riskLevelBadge} style={{ color: metrics.scoreColor, backgroundColor: metrics.scoreBg }}>{metrics.riskLevel}</div>
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
                      <strong style={{ color: "var(--text)" }}>{selected.platform || "unknown"}</strong>
                    </div>
                  </div>

                  <div className={styles.previewArea}>
                    <div className={styles.previewCanvas}>
                      <AuthImage analysisId={selected.id} alt="Captured preview" />
                    </div>
                    <div className={styles.actionRail}>
                      <button type="button" className={styles.primaryAction} onClick={() => window.open(selected.page_url, "_blank")}>Open Source</button>
                      <button type="button" className={styles.secondaryAction}>Export Report</button>
                    </div>
                  </div>
                </article>

                <div className={infoGridStyle(selected)}>
                  <article className={`${layout.card} ${styles.metadataCard}`}>
                    <div className={layout.panelHeader}>
                      <div>
                        <div className={layout.panelTitle}>Metadata</div>
                        <div className={layout.panelSub}>Technical attributes</div>
                      </div>
                    </div>
                    <div className={styles.metadataGrid}>
                      <MetaRow label="Type" value={selected.meta?.media_type || "Unknown"} />
                      <MetaRow label="Captured" value={new Date(selected.created_at).toLocaleString()} />
                      <MetaRow label="Scan ID" value={selected.id} />
                      <MetaRow label="Frames" value={selected.meta?.frame_count || "N/A"} />
                      <MetaRow label="Mode" value={selected.meta?.capture_mode || "N/A"} />
                    </div>
                  </article>

                  <article className={`${layout.card} ${styles.explanationCard}`}>
                    <div className={layout.panelHeader}>
                      <div>
                        <div className={layout.panelTitle}>Verdict Reasoning</div>
                        <div className={layout.panelSub}>Explanation of result</div>
                      </div>
                      <AlertIcon className={styles.smallIcon} style={{ color: metrics.verdictColor }} />
                    </div>
                    
                    <div className={styles.signalsBlock} style={{marginTop: "0"}}>
                      <div className={styles.signalsLabel}>Decision Summary</div>
                      <p className={styles.summaryText}>{reasoning.summary}</p>
                    </div>

                    <div className={styles.signalsBlock}>
                      <div className={styles.signalsLabel}>Score Interpretation</div>
                      <p className={styles.summaryText}>{reasoning.interpretation}</p>
                    </div>

                    <div className={styles.signalsBlock}>
                      <div className={styles.signalsLabel}>Key Signals Detected</div>
                      <ul className={styles.reasonList}>
                        {reasoning.signals.map((signal, idx) => <li key={idx}>{signal}</li>)}
                      </ul>
                    </div>
                    
                    <div className={styles.signalsBlock}>
                      <div className={styles.signalsLabel}>Decision Logic & Rules</div>
                      <p className={styles.summaryText}>{reasoning.logic}</p>
                    </div>

                    <div className={styles.policyBox} style={{ borderColor: policy.color, backgroundColor: policy.bg, color: policy.color, opacity: 0.9 }}>
                      <strong style={{ color: policy.color }}>Recommended Policy: </strong>
                      <span style={{ color: "var(--text)" }}>{policy.text}</span>
                    </div>
                  </article>
                </div>
              </section>
            );
          })()}
        </section>
      )}
    </div>
  );
}

function infoGridStyle(item) {
  return styles.infoGrid;
}

function MetaRow({ label, value }) {
  return (
    <div className={styles.metaRow}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AuthImage({ analysisId, alt, className, showLoader = true }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl = null;
    const loadImg = async () => {
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
    };
    if (analysisId) {
      setSrc(null);
      setError(false);
      loadImg();
    }
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [analysisId]);

  if (error) return (
    <div className={styles.errorThumb}>
      <ImageIcon className={styles.previewIcon} />
    </div>
  );

  if (!src) return showLoader ? <span className={styles.loadingText}>Loading...</span> : <div className={styles.loaderThumb} />;

  return <img src={src} alt={alt} className={className || styles.previewImg} />;
}
