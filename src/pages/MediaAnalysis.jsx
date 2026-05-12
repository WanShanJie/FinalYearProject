import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { ImageIcon, SearchIcon } from "../components/system/SystemIcons";
import { getDisplayMetrics } from "./mediaAnalysisShared";
import { getAnalysisStatus } from "../api/auth";
import { formatDate } from "../utils/formatDate";

// ── In-progress states that should trigger polling ────────────────────────────
const ACTIVE_STATUSES = new Set(["PENDING", "PROCESSING"]);
// Stop polling jobs that have been active for more than 12 minutes client-side
const MAX_POLL_AGE_MS = 12 * 60 * 1000;

// ── Progress bar shown for PENDING / PROCESSING rows ─────────────────────────
const STAGE_LABELS = {
  queued:             "Queued…",
  starting:           "Starting worker…",
  frame_extraction:   "Extracting frames…",
  face_detection:     "Detecting faces…",
  quality_gate:       "Quality check…",
  inference_alt:      "Running AltFreezing model…",
  inference_vit:      "Running ViT model…",
  inference_xception: "Running Xception model…",
  inference_wav2lip:  "Audio-visual sync check…",
  fusion:             "Computing verdict…",
  saving:             "Saving results…",
};

function ProcessingBadge({ progress = 0, stage }) {
  const label = STAGE_LABELS[stage] || "Processing…";
  return (
    <div style={{ minWidth: 180 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: "0.7rem", color: "var(--text-muted, #888)", marginBottom: 4,
      }}>
        <span>{label}</span>
        <span>{progress}%</span>
      </div>
      <div style={{
        height: 6, borderRadius: 3,
        background: "var(--border, #333)", overflow: "hidden",
      }}>
        <div style={{
          height: "100%", borderRadius: 3,
          background: "var(--accent, #6366f1)",
          width: `${progress}%`,
          transition: "width 0.4s ease",
        }} />
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

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadPanel({ onQueued }) {
  const [file, setFile] = React.useState(null);
  const [title, setTitle] = React.useState("");
  const [platform, setPlatform] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [uploadMsg, setUploadMsg] = React.useState("");
  const inputRef = React.useRef(null);

  function pickFile(f) {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    setUploadMsg("");
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) pickFile(f);
  }

  async function handleSubmit() {
    if (!file) return;
    setUploading(true);
    setUploadMsg("Uploading…");
    try {
      const token = localStorage.getItem("token");
      const fd = new FormData();
      fd.append("file", file);
      if (title) fd.append("title", title);
      if (platform) fd.append("platform", platform);

      const res = await fetch(`${API_BASE}/api/analysis/video`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.detail || "Upload failed");

      setUploadMsg(`Queued — analysis #${json.analysis_id}`);
      onQueued({
        id: json.analysis_id,
        title: title || file.name,
        platform: platform || "upload",
        status: "PENDING",
        verdict: "PENDING",
        score: 0,
        created_at: new Date().toISOString(),
        _progress: 0,
        _stage: "queued",
      });
      setFile(null);
      setTitle("");
      setPlatform("");
    } catch (err) {
      setUploadMsg(`Error: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <article className={styles.uploadPanel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text)" }}>Submit Video for Analysis</div>
          <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 2 }}>
            Upload a video file — it will be queued and processed in the background
          </div>
        </div>
      </div>

      <div
        className={dragging ? `${styles.uploadZone} ${styles.uploadZoneDrag}` : styles.uploadZone}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mp4,.mov,.avi,.webm,.mkv"
          style={{ display: "none" }}
          onChange={e => pickFile(e.target.files?.[0])}
        />
        <div className={styles.uploadZoneText}>
          {dragging ? "Drop to upload" : "Click or drag a video file here"}
        </div>
        <div className={styles.uploadZoneSub}>MP4, MOV, AVI, WebM, MKV — any size</div>
      </div>

      {file && (
        <div className={styles.uploadFileSelected}>
          <span style={{ fontSize: "1.2rem" }}>🎬</span>
          <span className={styles.uploadFileName}>{file.name}</span>
          <span className={styles.uploadFileSize}>{formatBytes(file.size)}</span>
        </div>
      )}

      {file && (
        <div className={styles.uploadFields}>
          <div className={styles.uploadField}>
            <input
              type="text"
              placeholder="Title (optional)"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className={styles.uploadField}>
            <select value={platform} onChange={e => setPlatform(e.target.value)}>
              <option value="">Platform (optional)</option>
              <option value="youtube">YouTube</option>
              <option value="facebook">Facebook</option>
              <option value="tiktok">TikTok</option>
              <option value="upload">Direct Upload</option>
            </select>
          </div>
        </div>
      )}

      {file && (
        <div className={styles.uploadActions}>
          <button
            className={styles.uploadSubmitBtn}
            onClick={handleSubmit}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Analyze Video"}
          </button>
          <button
            className={styles.uploadClearBtn}
            onClick={() => { setFile(null); setTitle(""); setPlatform(""); setUploadMsg(""); }}
            disabled={uploading}
          >
            Clear
          </button>
          {uploadMsg && (
            <span className={styles.uploadProgress}>{uploadMsg}</span>
          )}
        </div>
      )}
    </article>
  );
}

export default function MediaAnalysis() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [clearingAll, setClearingAll] = useState(false);
  const itemsPerPage = 8;
  const pollTimerRef = useRef(null);

  // ── Fetch full detection list ─────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("http://localhost:8000/api/history", {
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
        setDetections(json.data || []);
      }
    } catch (err) {
      console.error("MediaAnalysis fetch error:", err);
      setFeedback({ type: "error", text: "Unable to load detection history." });
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => { 
    fetchData(); 
    window.addEventListener("force-sync", fetchData);
    return () => window.removeEventListener("force-sync", fetchData);
  }, [fetchData]);

  // ── Poll active jobs every 3 s, stop when none remain ────────────────────
  useEffect(() => {
    const now = Date.now();
    const activeItems = detections.filter(d =>
      ACTIVE_STATUSES.has(d.status) &&
      (now - new Date(d.created_at).getTime()) < MAX_POLL_AGE_MS
    );
    // Mark timed-out items as ERROR locally so they stop being polled
    detections.forEach(d => {
      if (ACTIVE_STATUSES.has(d.status) && (now - new Date(d.created_at).getTime()) >= MAX_POLL_AGE_MS) {
        setDetections(prev => prev.map(x => x.id === d.id ? { ...x, status: "ERROR", verdict: "INCONCLUSIVE" } : x));
      }
    });
    if (activeItems.length === 0) {
      clearTimeout(pollTimerRef.current);
      return;
    }

    async function pollActive() {
      // Fetch fresh status for each active job
      const updates = await Promise.all(
        activeItems.map(item =>
          getAnalysisStatus(item.id).catch(() => null)
        )
      );

      let changed = false;
      setDetections(prev => {
        const map = new Map(prev.map(d => [d.id, d]));
        updates.forEach((upd, i) => {
          if (!upd) return;
          const old = map.get(activeItems[i].id);
          if (old && (old.status !== upd.status || old.verdict !== upd.verdict)) {
            map.set(old.id, {
              ...old,
              status:   upd.status,
              verdict:  upd.verdict  ?? old.verdict,
              score:    upd.score    ?? old.score,
              // keep progress/stage for the UI
              _progress: upd.progress ?? 0,
              _stage:    upd.stage    ?? null,
            });
            changed = true;
          } else if (old && ACTIVE_STATUSES.has(upd.status)) {
            // Still processing — update progress bar only
            map.set(old.id, {
              ...old,
              _progress: upd.progress ?? old._progress ?? 0,
              _stage:    upd.stage    ?? old._stage,
            });
          }
        });
        return changed ? Array.from(map.values()) : prev;
      });

      // Schedule next poll if any are still active
      pollTimerRef.current = setTimeout(pollActive, 3000);
    }

    pollTimerRef.current = setTimeout(pollActive, 3000);
    return () => clearTimeout(pollTimerRef.current);
  }, [detections]);

  function resolveApiError(payload, fallbackMessage) {
    if (typeof payload?.detail === "string") return payload.detail;
    if (typeof payload?.message === "string") return payload.message;
    return fallbackMessage;
  }

  async function deleteDetection(item) {
    if (!item?.id) return;
    const confirmed = window.confirm(`Are you sure you want to delete "${item.title || "this detection record"}"?`);
    if (!confirmed) return;

    setDeletingId(item.id);
    setFeedback(null);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`http://localhost:8000/api/history/${item.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        navigate("/signin", { replace: true });
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(resolveApiError(payload, "Unable to delete this detection record."));
      }

      setDetections((prev) => prev.filter((entry) => entry.id !== item.id));
      setFeedback({
        type: "success",
        text: payload.message || "Detection record deleted successfully."
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text: err.message || "Unable to delete this detection record."
      });
    } finally {
      setDeletingId(null);
    }
  }

  async function clearHistory() {
    const confirmed = window.confirm("Are you sure you want to delete all detection history? This will also remove saved media files from the server.");
    if (!confirmed) return;

    setClearingAll(true);
    setFeedback(null);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch("http://localhost:8000/api/history/clear", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        navigate("/signin", { replace: true });
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        throw new Error(resolveApiError(payload, "Unable to clear detection history."));
      }

      setDetections([]);
      setFeedback({
        type: "success",
        text: payload.message || "Detection history cleared successfully."
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text: err.message || "Unable to clear detection history."
      });
    } finally {
      setClearingAll(false);
    }
  }

  const filteredItems = useMemo(() => {
    let result = detections;
    
    // Combine local query with Sidebar search params
    const sq = (query || searchParams.get("search") || "").trim().toLowerCase();
    const dt = searchParams.get("date");
    const vd = searchParams.get("verdict");

    if (sq) {
      result = result.filter(item =>
        [item.title, item.platform, item.verdict, item.page_url].join(" ").toLowerCase().includes(sq)
      );
    }
    
    if (dt) {
      result = result.filter(item => item.created_at && item.created_at.startsWith(dt));
    }
    
    if (vd && vd !== "All") {
      result = result.filter(item => {
        const metrics = getDisplayMetrics(item.verdict, item.score);
        return metrics.displayVerdict.toLowerCase() === vd.toLowerCase();
      });
    }
    
    return result;
  }, [query, detections, searchParams]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query]);

  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const paginatedItems = filteredItems.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  if (loading) {
    return (
      <div className={layout.page}>
        <section className={layout.heroPanel}>
          <div className={layout.pageTitle}>Loading Detection History...</div>
        </section>
      </div>
    );
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Detection List</div>
          <p className={layout.pageSub}>
            Browse all analyzed media first, then open a dedicated detail page for the record you want to inspect.
          </p>
        </div>
        <div className={layout.pill}>
          <SearchIcon className={styles.smallIcon} />
          <span>History overview</span>
        </div>
      </section>



      {feedback && (
        <section className={feedback.type === "error" ? styles.feedbackError : styles.feedbackSuccess}>
          {feedback.text}
        </section>
      )}

      {detections.length === 0 ? (
        <section className={layout.panel} style={{ textAlign: "center", padding: "60px 20px" }}>
          <div className={layout.panelTitle}>No Detections Found</div>
          <p className={layout.pageSub} style={{ margin: "12px auto" }}>You have not analyzed any media yet.</p>
        </section>
      ) : (
        <section className={styles.listPageShell}>
          <article className={`${layout.tableCard} ${styles.listPagePanel}`}>
            <div className={styles.listHeader}>
              <div className={styles.listHeaderTop}>
                <div>
                  <div className={layout.panelTitle}>Detection History</div>
                  <div className={layout.panelSub}>{filteredItems.length} items found</div>
                </div>
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={clearHistory}
                  disabled={clearingAll || deletingId !== null || detections.length === 0}
                >
                  {clearingAll ? "Clearing..." : "Clear All"}
                </button>
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
                const isActive  = ACTIVE_STATUSES.has(item.status);
                const metrics   = getDisplayMetrics(item.verdict, item.score);
                return (
                  <div key={item.id} className={styles.mediaRowWrap}>
                    <button
                      type="button"
                      onClick={() => !isActive && navigate(`/media-analysis/${item.id}`)}
                      className={styles.mediaRow}
                      style={isActive ? { cursor: "default", opacity: 0.85 } : undefined}
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
                        <strong>{item.title || "Untitled media"}</strong>
                        <span>{item.platform || "Web"} – {formatDate(item.created_at)}</span>
                        {!isActive && (
                          <span className={styles.riskLabel} style={{ color: metrics.scoreColor }}>
                            {metrics.riskLevel} – {metrics.riskScore}%
                          </span>
                        )}
                      </div>
                      <div className={styles.listStatusStack}>
                        {isActive ? (
                          <ProcessingBadge
                            progress={item._progress ?? 0}
                            stage={item._stage ?? "queued"}
                          />
                        ) : (
                          <>
                            <VerdictBadge verdict={metrics.displayVerdict} color={metrics.verdictColor} bg={metrics.verdictBg} />
                            <span className={styles.viewHint}>View Details</span>
                          </>
                        )}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={styles.rowDeleteButton}
                      onClick={() => deleteDetection(item)}
                      disabled={clearingAll || deletingId === item.id}
                    >
                      {deletingId === item.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className={styles.pagination}>
                <button
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((page) => page - 1)}
                  className={styles.pageBtn}
                >
                  Prev
                </button>
                <div className={styles.pageInfo}>
                  Page <strong>{currentPage}</strong> of {totalPages}
                </div>
                <button
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((page) => page + 1)}
                  className={styles.pageBtn}
                >
                  Next
                </button>
              </div>
            )}
          </article>
        </section>
      )}
    </div>
  );
}

function AuthImage({ analysisId, alt, className, showLoader = true }) {
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
      </div>
    );
  }

  if (!src) {
    return showLoader ? <span className={styles.loadingText}>Loading...</span> : <div className={styles.loaderThumb} />;
  }

  return <img src={src} alt={alt} className={className || styles.previewImg} />;
}
