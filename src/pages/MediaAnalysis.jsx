import React, { useMemo, useState, useEffect } from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { AlertIcon, CheckIcon, ImageIcon, SearchIcon, VideoIcon } from "../components/system/SystemIcons";
import { useNavigate, useSearchParams } from "react-router-dom";

// ─── Shared Risk & Presentation Logic ───────────────────────────────────────
// Forces synchronization between Verdict, Risk Score, and Risk Level.
// Display Verdicts are strictly: REAL | FAKE | INCONCLUSIVE
export function getDisplayMetrics(backendVerdict, rawScore) {
  const v = (backendVerdict || "").toUpperCase();
  const raw = rawScore ?? 0;

  // 1. Calculate Risk Score strictly from the raw score
  let riskScore = Math.round(raw * 100);

  // 2. Initial Map for Risk Level and Score Tone (Base)
  let riskLevel = "Medium Risk";
  let scoreTone = "amber";
  if (riskScore <= 29) {
    riskLevel = "Low Risk";
    scoreTone = "green";
  } else if (riskScore >= 70) {
    riskLevel = "High Risk";
    scoreTone = "red";
  }

  // 3. Determine Display Verdict
  let displayVerdict = v;
  if (!v || v === "UNKNOWN") {
    if (riskScore <= 29) displayVerdict = "REAL";
    else if (riskScore >= 70) displayVerdict = "FAKE";
    else displayVerdict = "INCONCLUSIVE";
  }

  // 4. Resolve Verdict-Aware Labels (Avoid confusion for overrides)
  if (displayVerdict === "REAL") {
    riskLevel = (riskScore < 30) ? "Low Risk" : "Legitimate"; // Don't call it high risk if we result in REAL
  }

  // 5. Determine Verdict Tone (Dominant styling color)
  let verdictTone = "amber";
  if (displayVerdict === "REAL") verdictTone = "green";
  else if (displayVerdict === "FAKE") verdictTone = "red";

  // 6. Mute score tone if it contradicts the final verdict
  if (displayVerdict === "REAL" && riskScore >= 50) {
    scoreTone = "amber"; // Mute from red to amber to avoid false danger signals
  } else if (displayVerdict === "FAKE" && riskScore < 50) {
    scoreTone = "amber"; // Mute from green to amber
  }

  return { riskScore, displayVerdict, riskLevel, scoreTone, verdictTone };
}

function getPolicyAction(displayVerdict) {
  if (displayVerdict === "FAKE") {
    return { text: "Warning recommended. Block or restrict sharing of this content.", tone: "red" };
  }
  if (displayVerdict === "REAL") {
    return { text: "No immediate action required. The content was classified as authentic by the final decision logic.", tone: "green" };
  }
  return { text: "Review carefully before trusting or sharing. Mixed signals detected.", tone: "amber" };
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
    } else if (displayVerdict === "REAL") {
      summary = `Analysis found no significant evidence of digital manipulation. The content appears authentic based on frame-by-frame AI inspection.`;
    } else if (displayVerdict === "FAKE") {
      summary = `The AI model detected strong indicators of digital manipulation across multiple frames. This content is likely synthetically generated or altered.`;
    } else {
      summary = `The analysis returned mixed or inconclusive signals. Evidence quality may have been too low for a definitive verdict.`;
    }
  }

  // 2. Score Interpretation
  let interpretation = "";
  if (isOverride && displayVerdict === "REAL" && riskScore >= 70) {
    interpretation = `The model produced a high suspicious score (about ${riskScore}%), which means some visual patterns looked unusual to the model. However, this score was reinterpreted using sequence stability and quality evidence before the final verdict was assigned.`;
  } else if (displayVerdict === "FAKE") {
    interpretation = `The model returned a suspiciously high score (${riskScore}%), confirming the presence of synthetic artifacts or deepfake manipulation patterns.`;
  } else if (displayVerdict === "REAL") {
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
    if (displayVerdict === "REAL") signals.push("No repeated frame artifacts detected", "Facial consistency within expected natural range");
    else if (displayVerdict === "FAKE") signals.push("High model confidence on multiple frames", "Anomalous facial patterns detected");
    else signals.push("Mixed signals across frame analysis", "Insufficient evidence for definitive conclusion");
  }

  // 4. Decision Logic / Override
  let logic = "";
  if (isTalkingHeadOverride) {
    logic = `The system applied the rule: stable_bright_talking_head_override, which reduced the likelihood of false detection for a stable interview-style video with strong temporal consistency.`;
  } else if (reasonCode) {
    logic = `The system applied the decision rule: ${reasonCode}.`;
  } else {
    logic = `The verdict was derived directly from the model score falling into the ${displayVerdict} threshold range.`;
  }

  return { summary, interpretation, signals, logic };
}

// ─── Components ─────────────────────────────────────────────────────────────

function RiskRing({ riskScore, tone, scoreTone }) {
  const colorMap = { green: "var(--success)", amber: "var(--warning)", red: "var(--danger)" };
  // Visual ring uses the numeric score tone
  const color = colorMap[scoreTone] || "var(--primary)";
  const background = `conic-gradient(${color} 0 ${riskScore}%, var(--surface-2) ${riskScore}% 100%)`;
  return (
    <div className={styles.confidenceRing} style={{ background }}>
      <div className={styles.confidenceInner}>
        <span style={{ color }}>{riskScore}%</span>
        <small>score</small>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict, tone }) {
  const badgeMap = { red: layout.badgeRed, green: layout.badgeGreen, amber: layout.badgeAmber };
  return <span className={`${layout.badge} ${badgeMap[tone] || layout.badgeAmber}`}>{verdict}</span>;
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function MediaAnalysis() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
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
              {filteredItems.map((item) => {
                const { riskScore, displayVerdict, riskLevel, scoreTone, verdictTone } = getDisplayMetrics(item.verdict, item.score);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={item.id === (selected?.id) ? `${styles.mediaRow} ${styles.mediaRowActive}` : styles.mediaRow}
                  >
                    <div className={styles.thumb}>
                      {item.meta?.media_type === "video" ? <VideoIcon className={styles.rowIcon} /> : <ImageIcon className={styles.rowIcon} />}
                    </div>
                    <div className={styles.mediaMeta}>
                      <strong>{item.title}</strong>
                      <span>{item.platform || "Web"} · {new Date(item.created_at).toLocaleDateString()}</span>
                      <span className={styles.riskLabel} data-tone={scoreTone}>{riskLevel} · {riskScore}%</span>
                    </div>
                    <VerdictBadge verdict={displayVerdict} tone={verdictTone} />
                  </button>
                );
              })}
            </div>
          </article>

          {selected && (() => {
            const metrics = getDisplayMetrics(selected.verdict, selected.score);
            const policy = getPolicyAction(metrics.displayVerdict);
            const reasoning = buildReasoning(selected, metrics);
            const policyColorMap = { green: layout.badgeGreen, amber: layout.badgeAmber, red: layout.badgeRed };

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
                        <VerdictBadge verdict={metrics.displayVerdict} tone={metrics.verdictTone} />
                        <div className={styles.riskLevelBadge} data-tone={metrics.scoreTone}>{metrics.riskLevel}</div>
                      </div>
                      <RiskRing riskScore={metrics.riskScore} tone={metrics.verdictTone} scoreTone={metrics.scoreTone} />
                    </div>
                  </div>

                  <div className={styles.riskStrip}>
                    <div className={styles.riskStripItem}>
                      <span>Model Score</span>
                      <strong data-tone={metrics.scoreTone}>{metrics.riskScore}%</strong>
                    </div>
                    <div className={styles.riskStripItem}>
                      <span>Risk Level</span>
                      <strong data-tone={metrics.scoreTone}>{metrics.riskLevel}</strong>
                    </div>
                    <div className={styles.riskStripItem}>
                      <span>Final Verdict</span>
                      <strong data-tone={metrics.verdictTone}>{metrics.displayVerdict}</strong>
                    </div>
                    <div className={styles.riskStripItem}>
                      <span>Platform</span>
                      <strong>{selected.platform || "Web"}</strong>
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
                      {metrics.verdictTone === "red" ?
                        <AlertIcon className={`${styles.smallIcon} ${layout.toneRed}`} /> :
                        <CheckIcon className={`${styles.smallIcon} ${metrics.verdictTone === "green" ? layout.toneGreen : layout.toneAmber}`} />}
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

                    <div className={`${styles.policyBox} ${policyColorMap[policy.tone] || ""}`}>
                      <strong>Recommended Policy: </strong>{policy.text}
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

function AuthImage({ analysisId, alt }) {
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
    // Cleanup blob URL to prevent memory leaks when changing selected items
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [analysisId]);

  if (error) return (
    <>
      <ImageIcon className={styles.previewIcon} />
      <span>Preview not available for this analysis</span>
    </>
  );

  if (!src) return <span className={styles.loadingText}>Loading preview...</span>;

  return <img src={src} alt={alt} className={styles.previewImg} />;
}
