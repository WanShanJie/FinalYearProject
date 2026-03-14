import React, { useState } from "react";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./BlocklistManager.module.css";
import { blockControls, blocklistEntries, moderationRules, moderationWorkflow } from "../data/systemMockData";
import { AlertIcon, CheckIcon, LockIcon, ShieldIcon, SyncIcon } from "../components/system/SystemIcons";
import { useNavigate } from "react-router-dom";

export default function BlocklistManager() {
  const navigate = useNavigate();
  const [autoBlock, setAutoBlock] = useState(blockControls.autoBlockEnabled);
  const [globalProtection, setGlobalProtection] = useState(blockControls.globalProtection);
  const [strictMode, setStrictMode] = useState(blockControls.strictMode);
  const [blockedItems, setBlockedItems] = useState([]);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
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
          // Filter to show items that are FAKE or SUSPICIOUS (blocked by policy)
          setBlockedItems(json.data.filter(i => i.verdict === "FAKE" || i.verdict === "SUSPICIOUS"));
        }
      } catch (err) {
        console.error("Blocklist fetch error:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Blocklist Manager</div>
          <p className={layout.pageSub}>
            Configure global blocking controls and manage moderation outcomes. This table shows media that was automatically or manually blocked based on your policies.
          </p>
        </div>
        <div className={layout.pill}>
          <ShieldIcon className={styles.smallIcon} />
          <span>Policy-driven enforcement</span>
        </div>
      </section>

      <section className={styles.controlGrid}>
        <ControlCard
          title="Auto-block deepfakes"
          description="Automatically block content when fake confidence crosses the configured threshold."
          checked={autoBlock}
          onChange={() => setAutoBlock((prev) => !prev)}
          tone="blue"
        />
        <ControlCard
          title="Global blocking protection"
          description="Apply synced community rules and known threat fingerprints to new detections."
          checked={globalProtection}
          onChange={() => setGlobalProtection((prev) => !prev)}
          tone="cyan"
        />
        <ControlCard
          title="Strict suspicious policy"
          description="Keep suspicious items in review queue unless explicitly allowed by an analyst."
          checked={strictMode}
          onChange={() => setStrictMode((prev) => !prev)}
          tone="amber"
        />
      </section>

      <section className={layout.grid2}>
        <article className={layout.ruleCard + " " + styles.rulesPanel}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Moderation Policies</div>
              <div className={layout.panelSub}>Active rules for automatic content enforcement</div>
            </div>
            <button type="button" className={styles.syncButton}>
              <SyncIcon className={styles.smallIcon} />
              <span>Sync policies</span>
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

        <article className={layout.ruleCard + " " + styles.workflowPanel}>
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
              Global database entries remain read-only. Your local settings determine the response to matching fingerprints.
            </p>
          </div>
        </article>
      </section>

      <section className={layout.tableCard + " " + styles.tableSection}>
        <div className={layout.panelHeader}>
          <div>
            <div className={layout.panelTitle}>Blocked Media Table</div>
            <div className={layout.panelSub}>History of blocked content associated with your account</div>
          </div>
          <span className={layout.pill}>Live protection</span>
        </div>

        <div className={styles.tableWrap}>
          {loading ? (
            <div style={{padding: 40, textAlign: "center"}}>Loading blocked items...</div>
          ) : blockedItems.length === 0 ? (
            <div style={{padding: 40, textAlign: "center", opacity: 0.6}}>No blocked items found.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Media</th>
                  <th>Scan ID</th>
                  <th>Source</th>
                  <th>Date Added</th>
                  <th>Decision</th>
                  <th>Workflow Note</th>
                </tr>
              </thead>
              <tbody>
                {blockedItems.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className={styles.thumbCell}>
                        <div className={styles.thumb}>{entry.meta?.media_type === "video" ? "V" : "I"}</div>
                        <div>
                          <strong>{entry.title}</strong>
                          <span>{entry.platform}</span>
                        </div>
                      </div>
                    </td>
                    <td className={styles.hashCell}>{entry.id}</td>
                    <td>{entry.platform}</td>
                    <td>{new Date(entry.created_at).toLocaleDateString()}</td>
                    <td>
                      <span className={`${layout.badge} ${layout.badgeRed}`}>
                        <AlertIcon className={styles.smallIcon} />
                        Blocked
                      </span>
                    </td>
                    <td>{entry.meta?.decision?.final_explanation || "Blocked by policy."}</td>
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

function ControlCard({ title, description, checked, onChange, tone }) {
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
          className={checked ? `${styles.switch} ${styles[`switch_${tone}`]} ${styles.switchActive}` : styles.switch}
          onClick={onChange}
        >
          <span className={checked ? `${styles.knob} ${styles.knobActive}` : styles.knob} />
        </button>
      </div>
    </article>
  );
}
