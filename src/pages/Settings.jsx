import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { formatDateTime } from "../utils/formatDate";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Settings.module.css";
import { settingsCards, systemSettings } from "../data/systemMockData";
import { CheckIcon, LinkIcon, MoonIcon, SettingsIcon, SunIcon } from "../components/system/SystemIcons";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` };
}

export default function Settings() {
  const navigate = useNavigate();
  const { theme, setTheme } = useOutletContext() || {};
  const [analystReview, setAnalystReview] = useState(systemSettings.analystReview);
  const [notifications, setNotifications] = useState(systemSettings.notifications);
  const [strictMode, setStrictMode] = useState(systemSettings.strictMode);
  const [autoSync, setAutoSync] = useState(systemSettings.autoSync);
  const [threshold, setThreshold] = useState(systemSettings.threshold);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // "saving" | "saved" | "error"
  const saveTimer = useRef(null);
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [revokingId, setRevokingId] = useState(null);
  const fetchDevicesLastAt = useRef(0);

  // ── Load settings from backend on mount ──────────────────────────────────
  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch(`${API_BASE}/api/settings`, { headers: authHeaders() });
        if (res.status === 401) { navigate("/signin", { replace: true }); return; }
        const json = await res.json();
        if (json.ok && json.settings) {
          const s = json.settings;
          setAnalystReview(s.analyst_review ?? systemSettings.analystReview);
          setNotifications(s.notifications ?? systemSettings.notifications);
          setStrictMode(s.strict_mode ?? systemSettings.strictMode);
          setAutoSync(s.auto_sync ?? systemSettings.autoSync);
          setThreshold(s.threshold ?? systemSettings.threshold);
        }
      } catch { /* keep defaults */ }
      finally { setSettingsLoaded(true); }
    }
    loadSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist a settings patch to the backend ───────────────────────────────
  const persistSettings = useCallback(async (patch) => {
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

  function toggle(field, setter, current) {
    const next = !current;
    setter(next);
    persistSettings({ [field]: next });
  }

  async function fetchDevices() {
    const now = Date.now();
    if (now - fetchDevicesLastAt.current < 3000) return;
    fetchDevicesLastAt.current = now;
    try {
      setDevicesLoading(true);
      setDevicesError("");
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/api/extension/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        navigate("/signin", { replace: true });
        return;
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.detail || "Unable to load linked extensions.");
      }
      setDevices(json.data || []);
    } catch (err) {
      setDevicesError(err.message || "Unable to load linked extensions.");
    } finally {
      setDevicesLoading(false);
    }
  }

  useEffect(() => {
    fetchDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Real-time synchronization with the browser extension.
    // If the user connects or disconnects via the popup, it alerts the page natively.
    function handleExtensionMessages(event) {
      if (event.data?.type === "A2U_EXTENSION_STATUS_CHANGED") {
        fetchDevices();
      }
    }
    window.addEventListener("message", handleExtensionMessages);
    return () => window.removeEventListener("message", handleExtensionMessages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revokeDevice(deviceId) {
    try {
      setRevokingId(deviceId);
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/api/extension/devices/${deviceId}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.detail || "Unable to revoke extension.");
      }
      
      // Dispatch event to the injected content script to wipe its linked token locally.
      window.postMessage({ type: "A2U_PORTAL_REVOKED" }, "*");
      
      await fetchDevices();
    } catch (err) {
      setDevicesError(err.message || "Unable to revoke extension.");
    } finally {
      setRevokingId(null);
    }
  }

  const activeDevice = devices.find(d => d.is_active);

  // Threshold: update local state on drag, persist only on release
  function handleThresholdChange(e) { setThreshold(Number(e.target.value)); }
  function handleThresholdCommit(e)  { persistSettings({ threshold: Number(e.target.value) }); }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Settings</div>
          <p className={layout.pageSub}>
            System configuration panels for analyst review, notifications, strict mode, extension linking, and interface preferences.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {saveStatus === "saving" && <span style={{ fontSize: 13, color: "#94a3b8" }}>Saving…</span>}
          {saveStatus === "saved"  && <span style={{ fontSize: 13, color: "#22c55e" }}>Saved</span>}
          {saveStatus === "error"  && <span style={{ fontSize: 13, color: "#ef4444" }}>Save failed</span>}
          <div className={layout.pill}>
            <SettingsIcon className={styles.smallIcon} />
            <span>Configuration center</span>
          </div>
        </div>
      </section>

      <section className={styles.settingsGrid}>
        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>System Preferences</div>
              <div className={layout.panelSub}>Core behaviour for analysis and moderation</div>
            </div>
          </div>

          {!settingsLoaded ? (
            <div style={{ padding: "16px 0", color: "#94a3b8", fontSize: 14 }}>Loading settings…</div>
          ) : (
            <>
              <div className={styles.toggleList}>
                <ToggleRow title="Analyst review" description="Require a human reviewer for inconclusive or sensitive detections." checked={analystReview} onChange={() => toggle("analyst_review", setAnalystReview, analystReview)} />
                <ToggleRow title="Notifications" description="Notify operators about detections, policy events, and sync issues." checked={notifications} onChange={() => toggle("notifications", setNotifications, notifications)} />
                <ToggleRow title="Strict mode" description="Increase sensitivity for high-risk sources and suspicious uploads." checked={strictMode} onChange={() => toggle("strict_mode", setStrictMode, strictMode)} />
                <ToggleRow title="Auto-sync global database" description="Keep threat fingerprints and moderation policies aligned automatically." checked={autoSync} onChange={() => toggle("auto_sync", setAutoSync, autoSync)} />
              </div>

              <div className={styles.sliderBlock}>
                <div className={styles.sliderHeader}>
                  <strong>Auto-block threshold</strong>
                  <span>{threshold}%</span>
                </div>
                <input type="range" min="50" max="99" value={threshold} onChange={handleThresholdChange} onMouseUp={handleThresholdCommit} onTouchEnd={handleThresholdCommit} className={styles.range} />
                <div className={styles.sliderFoot}>
                  <span>Cautious</span>
                  <span>Aggressive</span>
                </div>
              </div>
            </>
          )}
        </article>

        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Appearance</div>
              <div className={layout.panelSub}>Choose the light or dark theme for the system UI</div>
            </div>
          </div>

          <div className={styles.themeChooser}>
            <button type="button" onClick={() => setTheme && setTheme("light")} className={theme === "light" ? `${styles.themeCard} ${styles.themeCardActive}` : styles.themeCard}>
              <SunIcon className={styles.themeIcon} />
              <strong>Light Theme</strong>
              <span>Bright background with softer contrast</span>
            </button>
            <button type="button" onClick={() => setTheme && setTheme("dark")} className={theme === "dark" ? `${styles.themeCard} ${styles.themeCardActive}` : styles.themeCard}>
              <MoonIcon className={styles.themeIcon} />
              <strong>Dark Theme</strong>
              <span>High-contrast workspace for long review sessions</span>
            </button>
          </div>

          <div className={styles.appearanceNote}>
            Theme preference is stored locally, so the system keeps your chosen appearance when you come back.
          </div>
        </article>
      </section>

      <section className={styles.configGrid}>
        {settingsCards.map((item) => (
          <article key={item.title} className={`${layout.settingCard} ${styles.smallCard}`}>
            <strong>{item.title}</strong>
            <p>{item.description}</p>
          </article>
        ))}
      </section>

      <section className={styles.deviceGrid}>
        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Connected Extension</div>
              <div className={layout.panelSub}>The browser extension linked to your portal account</div>
            </div>
            <span className={layout.pill}><LinkIcon className={styles.smallIcon} />{activeDevice ? "1 connected" : "disconnected"}</span>
          </div>

          <div className={styles.extensionBanner}>
            <CheckIcon className={styles.themeIcon} />
            <div>
              <strong>Secure linking</strong>
              <p>When you connect the extension to your portal, background captures sync securely to your account. Only one active extension link is permitted at a time; new links automatically disconnect older ones.</p>
            </div>
          </div>

          {devicesLoading ? (
            <div className={styles.emptyBox}>Checking connection status…</div>
          ) : devicesError ? (
            <div className={styles.errorBox}>{devicesError}</div>
          ) : !activeDevice ? (
            <div className={styles.emptyBox}>
              <p style={{marginBottom: 12}}>No browser extension connected.</p>
              <button 
                onClick={() => window.postMessage({ type: "A2U_PORTAL_CONNECT" }, "*")}
                style={{ background: "var(--primary)", color: "white", padding: "8px 16px", borderRadius: 8, border: "none", fontWeight: 600, cursor: "pointer"}}
              >
                Connect Extension Automatically
              </button>
            </div>
          ) : (
            <div className={styles.deviceList}>
              <div key={activeDevice.id} className={styles.deviceCard}>
                <div>
                  <strong>{activeDevice.device_name}</strong>
                  <p>Version: {activeDevice.extension_version || "Unknown"}</p>
                  <p>Linked: {activeDevice.created_at ? formatDateTime(activeDevice.created_at) : "Unknown"}</p>
                  <p>Last seen: {activeDevice.last_seen_at ? formatDateTime(activeDevice.last_seen_at) : "No activity yet"}</p>
                </div>
                <div className={styles.deviceActions}>
                  <span className={styles.deviceActive}>Active</span>
                  <button type="button" className={styles.revokeButton} onClick={() => revokeDevice(activeDevice.id)} disabled={revokingId === activeDevice.id}>
                    {revokingId === activeDevice.id ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </article>


        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>API Configuration</div>
              <div className={layout.panelSub}>System integration settings</div>
            </div>
          </div>
          <div className={styles.formGroup}>
            <label>A<sup>2</sup>U API key</label>
            <div className={styles.inputRow}>
              <input type="password" placeholder="Enter your API key" />
              <button type="button">Save</button>
            </div>
          </div>
          <div className={styles.hintBox}>Keep the API key private and rotate it if access is shared or exposed.</div>

          <div className={styles.auditRows}>
            <div className={styles.auditRow}><span>Retention period</span><strong>{systemSettings.retention}</strong></div>
            <div className={styles.auditRow}><span>Analyst escalation</span><strong>{analystReview ? "Enabled" : "Disabled"}</strong></div>
            <div className={styles.auditRow}><span>Threat DB sync</span><strong>{autoSync ? "Automatic" : "Manual"}</strong></div>
          </div>
        </article>
      </section>
    </div>
  );
}

function ToggleRow({ title, description, checked, onChange }) {
  return (
    <div className={styles.toggleRow}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button type="button" role="switch" aria-checked={checked} onClick={onChange} className={checked ? `${styles.switch} ${styles.switchActive}` : styles.switch}>
        <span className={checked ? `${styles.knob} ${styles.knobActive}` : styles.knob} />
      </button>
    </div>
  );
}
