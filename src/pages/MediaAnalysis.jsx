import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./MediaAnalysis.module.css";
import { ImageIcon, SearchIcon } from "../components/system/SystemIcons";
import { getDisplayMetrics } from "./mediaAnalysisShared";

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

export default function MediaAnalysis() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [clearingAll, setClearingAll] = useState(false);
  const itemsPerPage = 8;

  useEffect(() => {
    async function fetchData() {
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
    }

    fetchData();
  }, [navigate]);

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
                const metrics = getDisplayMetrics(item.verdict, item.score);
                return (
                  <div key={item.id} className={styles.mediaRowWrap}>
                    <button
                      type="button"
                      onClick={() => navigate(`/media-analysis/${item.id}`)}
                      className={styles.mediaRow}
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
                        <span>{item.platform || "Web"} - {new Date(item.created_at).toLocaleDateString()}</span>
                        <span className={styles.riskLabel} style={{ color: metrics.scoreColor }}>
                          {metrics.riskLevel} - {metrics.riskScore}%
                        </span>
                      </div>
                      <div className={styles.listStatusStack}>
                        <VerdictBadge verdict={metrics.displayVerdict} color={metrics.verdictColor} bg={metrics.verdictBg} />
                        <span className={styles.viewHint}>View Details</span>
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
