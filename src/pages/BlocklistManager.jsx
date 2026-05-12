import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./BlocklistManager.module.css";
import { formatDate } from "../utils/formatDate";
import { blockControls, moderationRules, moderationWorkflow } from "../data/systemMockData";
import { AlertIcon, LockIcon, ShieldIcon, SyncIcon } from "../components/system/SystemIcons";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";
function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` };
}

export default function BlocklistManager() {
  const navigate = useNavigate();
  const [autoBlock, setAutoBlock] = useState(blockControls.autoBlockEnabled);
  const [globalProtection, setGlobalProtection] = useState(blockControls.globalProtection);
  const [strictMode, setStrictMode] = useState(blockControls.strictMode);
  const [controlsLoaded, setControlsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const saveTimer = useRef(null);
  const [blockedItems, setBlockedItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [feedback, setFeedback] = useState(null);

  // ── Load controls from backend on mount ──────────────────────────────────
  useEffect(() => {
    async function loadControls() {
      try {
        const res = await fetch(`${API_BASE}/api/settings`, { headers: authHeaders() });
        if (res.status === 401) { navigate("/signin", { replace: true }); return; }
        const json = await res.json();
        if (json.ok && json.settings) {
          const s = json.settings;
          setAutoBlock(s.auto_block ?? blockControls.autoBlockEnabled);
          setGlobalProtection(s.global_protection ?? blockControls.globalProtection);
          setStrictMode(s.strict_mode ?? blockControls.strictMode);
        }
      } catch { /* keep defaults */ }
      finally { setControlsLoaded(true); }
    }
    loadControls();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistControls = useCallback(async (patch) => {
    setSaveStatus("saving");
    clearTimeout(saveTimer.current);
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(patch),
      });
      if (res.status === 401) { navigate("/signin", { replace: true }); return; }
      const json = await res.json();
      setSaveStatus(json.ok ? "saved" : "error");
    } catch { setSaveStatus("error"); }
    saveTimer.current = setTimeout(() => setSaveStatus(null), 2000);
  }, [navigate]);

  function toggleControl(field, setter, current) {
    const next = !current;
    setter(next);
    persistControls({ [field]: next });
  }

  function resolveApiError(payload, fallbackMessage) {
    if (typeof payload?.detail === "string") return payload.detail;
    if (typeof payload?.message === "string") return payload.message;
    return fallbackMessage;
  }

  async function fetchBlocklist({ quiet = false } = {}) {
    if (quiet) setRefreshing(true);
    else setLoading(true);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch("http://localhost:8000/api/blocklist", {
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
        setBlockedItems(json.data || []);
      }
    } catch (err) {
      console.error("Blocklist fetch error:", err);
      if (quiet) {
        setFeedback({ type: "error", text: "Unable to refresh the blocklist right now." });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchBlocklist();
  }, []);

  async function removeFromBlocklist(entry) {
    if (!entry?.id) return;
    const confirmed = window.confirm(`Are you sure you want to remove "${entry.title || "this media item"}" from the blocklist?`);
    if (!confirmed) return;

    setRemovingId(entry.id);
    setFeedback(null);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`http://localhost:8000/api/blocklist/${entry.id}`, {
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
        throw new Error(resolveApiError(payload, "Unable to remove this media item from the blocklist."));
      }

      setBlockedItems((prev) => prev.filter((item) => item.id !== entry.id));
      setFeedback({
        type: "success",
        text: payload.message || "Media removed from the blocklist."
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text: err.message || "Unable to remove this media item from the blocklist."
      });
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Blocklist Manager</div>
          <p className={layout.pageSub}>
            Configure blocking controls and remove blocked media when it should become accessible again. Active entries shown here are enforced by the backend and extension sync.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {saveStatus === "saving" && <span style={{ fontSize: 13, color: "#94a3b8" }}>Saving…</span>}
          {saveStatus === "saved"  && <span style={{ fontSize: 13, color: "#22c55e" }}>Saved</span>}
          {saveStatus === "error"  && <span style={{ fontSize: 13, color: "#ef4444" }}>Save failed</span>}
          <div className={layout.pill}>
            <ShieldIcon className={styles.smallIcon} />
            <span>Policy-driven enforcement</span>
          </div>
        </div>
      </section>

      {feedback && (
        <section className={feedback.type === "error" ? styles.feedbackError : styles.feedbackSuccess}>
          {feedback.text}
        </section>
      )}

      <section className={styles.controlGrid}>
        <ControlCard
          title="Auto-block deepfakes"
          description="Automatically block content when fake confidence crosses the configured threshold."
          checked={autoBlock}
          onChange={() => toggleControl("auto_block", setAutoBlock, autoBlock)}
          tone="blue"
          disabled={!controlsLoaded}
        />
        <ControlCard
          title="Global blocking protection"
          description="Apply synced community rules and known threat fingerprints to new detections."
          checked={globalProtection}
          onChange={() => toggleControl("global_protection", setGlobalProtection, globalProtection)}
          tone="cyan"
          disabled={!controlsLoaded}
        />
        <ControlCard
          title="Strict suspicious policy"
          description="Keep suspicious items in review queue unless explicitly allowed by an analyst."
          checked={strictMode}
          onChange={() => toggleControl("strict_mode", setStrictMode, strictMode)}
          tone="amber"
          disabled={!controlsLoaded}
        />
      </section>

      <section className={layout.grid2}>
        <article className={`${layout.ruleCard} ${styles.rulesPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Moderation Policies</div>
              <div className={layout.panelSub}>Active rules for automatic content enforcement</div>
            </div>
            <button type="button" className={styles.syncButton} onClick={() => fetchBlocklist({ quiet: true })}>
              <SyncIcon className={styles.smallIcon} />
              <span>{refreshing ? "Refreshing..." : "Refresh blocklist"}</span>
            </button>
          </div>

          <div className={styles.ruleList}>
            {moderationRules.map((rule) => (
              <div key={rule.id} className={styles.ruleCard}>
                <div className={styles.ruleTopRow}>
                  <div>
                    <strong>{rule.title}</strong>
                    <p>{rule.description}</p>
                  </div>
                  <div className={styles.ruleBadges}>
                    <span className={`${layout.badge} ${rule.action === "Block" ? layout.badgeRed : rule.action === "Review" ? layout.badgeAmber : layout.badgeGreen}`}>{rule.action}</span>
                    <span className={`${layout.badge} ${rule.status === "Active" ? layout.badgeBlue : layout.badgeCyan}`}>{rule.status}</span>
                  </div>
                </div>
                <div className={styles.ruleFooter}>
                  <span>Scope: {rule.scope}</span>
                  <span>Rule ID: {rule.id}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={`${layout.ruleCard} ${styles.workflowPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Moderation Workflow</div>
              <div className={layout.panelSub}>Path from detection to enforcement</div>
            </div>
          </div>
          <div className={styles.workflowList}>
            {moderationWorkflow.map((item, index) => (
              <div key={item.step} className={styles.workflowItem}>
                <div className={styles.stepBubble}>{index + 1}</div>
                <div>
                  <strong>{item.step}</strong>
                  <p>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.infoBanner}>
            <LockIcon className={`${styles.smallIcon} ${layout.toneCyan}`} />
            <p>
              Removing an entry here marks it unblocked in the backend, so future syncs stop restricting that media.
            </p>
          </div>
        </article>
      </section>

      <section className={`${layout.tableCard} ${styles.tableSection}`}>
        <div className={layout.panelHeader}>
          <div>
            <div className={layout.panelTitle}>Active Blocklist</div>
            <div className={layout.panelSub}>{blockedItems.length} blocked media items currently enforced</div>
          </div>
          <span className={layout.pill}>Live protection</span>
        </div>

        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.emptyState}>Loading blocklist...</div>
          ) : blockedItems.length === 0 ? (
            <div className={styles.emptyState}>
              No blocked items yet. High-risk deepfake detections will appear here automatically.
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Title / Platform</th>
                  <th>Fingerprint</th>
                  <th>Risk Score</th>
                  <th>Verdict</th>
                  <th>Source Scan</th>
                  <th>Date Added</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {blockedItems.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className={styles.thumbCell}>
                        <div className={styles.thumb}>{entry.platform?.[0]?.toUpperCase() || "?"}</div>
                        <div className={styles.itemMeta}>
                          <strong>{entry.title || "Untitled"}</strong>
                          <span>{entry.platform || "Unknown"}</span>
                          {entry.source_url && (
                            <a className={styles.sourceLink} href={entry.source_url} target="_blank" rel="noreferrer">
                              View source
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={styles.hashCell} title={entry.fingerprint_hash}>
                      {entry.fingerprint_hash?.slice(0, 12)}...
                    </td>
                    <td>
                      <span className={`${layout.badge} ${entry.risk_score >= 70 ? layout.badgeRed : layout.badgeAmber}`}>
                        {entry.risk_score}% - {entry.risk_level}
                      </span>
                    </td>
                    <td>
                      <span className={`${layout.badge} ${layout.badgeRed}`}>
                        <AlertIcon className={styles.smallIcon} /> {entry.verdict}
                      </span>
                    </td>
                    <td>{entry.analysis_id ? `#${entry.analysis_id}` : "-"}</td>
                    <td>{entry.created_at ? formatDate(entry.created_at) : "-"}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.actionButton}
                        onClick={() => removeFromBlocklist(entry)}
                        disabled={removingId === entry.id}
                      >
                        {removingId === entry.id ? "Removing..." : "Remove from Blocklist"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function ControlCard({ title, description, checked, onChange, tone, disabled }) {
  return (
    <article className={`${layout.card} ${styles.controlCard}`}>
      <div className={styles.controlTop}>
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          className={checked ? `${styles.switch} ${styles[`switch_${tone}`]} ${styles.switchActive}` : styles.switch}
          onClick={onChange}
        >
          <span className={checked ? `${styles.knob} ${styles.knobActive}` : styles.knob} />
        </button>
      </div>
    </article>
  );
}
