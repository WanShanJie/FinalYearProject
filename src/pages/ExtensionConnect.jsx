import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./ExtensionConnect.module.css";
import { LinkIcon, ShieldIcon, SyncIcon, CheckIcon } from "../components/system/SystemIcons";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function ExtensionConnect() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request_id");
  const [loading, setLoading] = React.useState(true);
  const [approving, setApproving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [info, setInfo] = React.useState(null);
  const [approved, setApproved] = React.useState(false);

  async function fetchStatus() {
    if (!requestId) {
      setError("Missing extension link request ID.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/extension/link/request/${requestId}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.detail || "Unable to load extension link request.");
      }
      setInfo(json);
      setApproved(json.status === "approved" || json.status === "redeemed");
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load extension link request.");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    fetchStatus();
  }, [requestId]);

  async function approveRequest() {
    if (!requestId) return;
    try {
      setApproving(true);
      setError("");
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/api/extension/link/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ request_id: requestId }),
      });
      const json = await res.json();
      if (res.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        navigate("/signin", { replace: true });
        return;
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.detail || "Failed to approve extension connection.");
      }
      setApproved(true);
      setInfo((prev) => ({ ...(prev || {}), ...json, status: json.status || "approved" }));
    } catch (err) {
      setError(err.message || "Failed to approve extension connection.");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Connect Browser Extension</div>
          <p className={layout.pageSub}>
            Approve the browser extension so it can send media captures to your account without asking you to sign in again.
          </p>
        </div>
        <div className={layout.pill}>
          <LinkIcon className={styles.inlineIcon} />
          <span>Secure one-time linking</span>
        </div>
      </section>

      <section className={styles.connectGrid}>
        <article className={`${layout.panel} ${styles.mainPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Extension approval</div>
              <div className={layout.panelSub}>The request expires automatically if it is not approved in time.</div>
            </div>
            {info?.status ? <span className={layout.pill}>{info.status}</span> : null}
          </div>

          {loading ? (
            <div className={styles.loadingBox}>Loading extension request…</div>
          ) : error ? (
            <div className={styles.errorBox}>{error}</div>
          ) : (
            <>
              <div className={styles.summaryCard}>
                <div className={styles.summaryRow}><span>Request ID</span><strong>{requestId}</strong></div>
                <div className={styles.summaryRow}><span>Device</span><strong>{info?.device_name || "Chrome Extension"}</strong></div>
                <div className={styles.summaryRow}><span>Version</span><strong>{info?.extension_version || "Unknown"}</strong></div>
                <div className={styles.summaryRow}><span>Expires at</span><strong>{info?.expires_at ? new Date(info.expires_at).toLocaleString() : "Unknown"}</strong></div>
              </div>

              {approved ? (
                <div className={styles.successBox}>
                  <CheckIcon className={styles.inlineIcon} />
                  <div>
                    <strong>Extension approved.</strong>
                    <p>You can return to the extension popup now. It should finish linking automatically in a few seconds.</p>
                  </div>
                </div>
              ) : (
                <div className={styles.actionArea}>
                  <button type="button" className={styles.approveButton} onClick={approveRequest} disabled={approving}>
                    {approving ? "Approving…" : "Approve extension connection"}
                  </button>
                  <p className={styles.helperText}>
                    This links the extension to your current signed-in portal account only. Other users will not be able to see your analysis history.
                  </p>
                </div>
              )}
            </>
          )}
        </article>

        <article className={`${layout.panel} ${styles.sidePanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>How it works</div>
              <div className={layout.panelSub}>Protection for account-bound extension linking</div>
            </div>
          </div>
          <div className={styles.stepList}>
            <div className={styles.stepItem}><ShieldIcon className={styles.inlineIcon} /><span>The extension creates a temporary one-time request.</span></div>
            <div className={styles.stepItem}><CheckIcon className={styles.inlineIcon} /><span>You approve it here while already signed in on the website.</span></div>
            <div className={styles.stepItem}><SyncIcon className={styles.inlineIcon} /><span>The extension redeems the approved request and stores its own scoped token.</span></div>
          </div>
        </article>
      </section>
    </div>
  );
}
