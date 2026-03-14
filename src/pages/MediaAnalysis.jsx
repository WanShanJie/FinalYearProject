import React, { useMemo, useState, useEffect } from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { AlertIcon, CheckIcon, ImageIcon, SearchIcon, VideoIcon } from "../components/system/SystemIcons";
import { useNavigate } from "react-router-dom";

function verdictBadge(verdict) {
  const v = (verdict || "").toLowerCase();
  if (v === "fake" || v === "suspicious") return `${layout.badge} ${layout.badgeRed}`;
  if (v === "real") return `${layout.badge} ${layout.badgeGreen}`;
  return `${layout.badge} ${layout.badgeAmber}`;
}

export default function MediaAnalysis() {
  const navigate = useNavigate();
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
            setSelectedId(json.data[0].id);
          }
        }
      } catch (err) {
        console.error("MediaAnalysis fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

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
            Review detections associated with your account. Detailed inspection of metadata, verdict reasoning, and evidence for content moderation.
          </p>
        </div>
        <div className={layout.pill}>
          <SearchIcon className={styles.smallIcon} />
          <span>Detailed review mode</span>
        </div>
      </section>

      {detections.length === 0 ? (
        <section className={layout.panel} style={{textAlign: "center", padding: "60px 20px"}}>
          <div className={layout.panelTitle}>No Detections Found</div>
          <p className={layout.pageSub} style={{margin: "12px auto"}}>You haven't analyzed any media yet. Use the browser extension to capture and analyze content.</p>
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
                  placeholder="Search by title, platform, or URL"
                  className={styles.searchInput}
                />
              </div>
            </div>

            <div className={styles.listBody}>
              {filteredItems.map((item) => (
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
                  </div>
                  <span className={verdictBadge(item.verdict)}>{item.verdict}</span>
                </button>
              ))}
            </div>
          </article>

          {selected && (
            <section className={styles.detailColumn}>
              <article className={`${layout.stackCard} ${styles.detailTopCard}`}>
                <div className={styles.detailHeader}>
                  <div>
                    <div className={styles.detailTitle}>{selected.title}</div>
                    <div className={styles.detailSub}>{selected.platform} · {selected.page_url}</div>
                  </div>
                  <div className={styles.headerRight}>
                    <span className={verdictBadge(selected.verdict)}>{selected.verdict}</span>
                    <div className={styles.confidenceRing}>
                      <div className={styles.confidenceInner}>
                        <span>{Math.round(selected.score * 100)}%</span>
                        <small>score</small>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={styles.previewArea}>
                  <div className={styles.previewCanvas}>
                    {selected.meta?.media_type === "video" ? <VideoIcon className={styles.previewIcon} /> : <ImageIcon className={styles.previewIcon} />}
                    <span>Preview not available in this view</span>
                  </div>
                  <div className={styles.actionRail}>
                    <button type="button" className={styles.primaryAction} onClick={() => window.open(selected.page_url, "_blank")}>Open Source</button>
                    <button type="button" className={styles.secondaryAction}>Export Report</button>
                  </div>
                </div>
              </article>

              <div className={styles.infoGrid}>
                <article className={`${layout.card} ${styles.metadataCard}`}>
                  <div className={layout.panelHeader}>
                    <div>
                      <div className={layout.panelTitle}>Metadata</div>
                      <div className={layout.panelSub}>Technical attributes captured</div>
                    </div>
                  </div>
                  <div className={styles.metadataGrid}>
                    <MetaRow label="Type" value={selected.meta?.media_type || "Unknown"} />
                    <MetaRow label="Platform" value={selected.platform} />
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
                      <div className={layout.panelSub}>Explanation of the model decision</div>
                    </div>
                    {(selected.verdict === "FAKE" || selected.verdict === "SUSPICIOUS") ? 
                      <AlertIcon className={`${styles.smallIcon} ${layout.toneRed}`} /> : 
                      <CheckIcon className={`${styles.smallIcon} ${selected.verdict === "REAL" ? layout.toneGreen : layout.toneAmber}`} />}
                  </div>
                  <p className={styles.summaryText}>
                    {selected.meta?.decision?.final_explanation || "No automated explanation available for this analysis."}
                  </p>
                  {selected.meta?.decision?.reasoning && (
                    <ul className={styles.reasonList}>
                      {selected.meta.decision.reasoning.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  )}
                  <div className={styles.policyBox}>
                    Policy: {selected.verdict === "FAKE" ? "Automated block recommended." : "No immediate action required."}
                  </div>
                </article>
              </div>
            </section>
          )}
        </section>
      )}
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
