import React, { useState } from "react";
import { useOutletContext } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Settings.module.css";
import { settingsCards, systemSettings } from "../data/systemMockData";
import { MoonIcon, SettingsIcon, SunIcon } from "../components/system/SystemIcons";

export default function Settings() {
  const { theme, setTheme } = useOutletContext() || {};
  const [analystReview, setAnalystReview] = useState(systemSettings.analystReview);
  const [notifications, setNotifications] = useState(systemSettings.notifications);
  const [strictMode, setStrictMode] = useState(systemSettings.strictMode);
  const [autoSync, setAutoSync] = useState(systemSettings.autoSync);
  const [threshold, setThreshold] = useState(systemSettings.threshold);

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Settings</div>
          <p className={layout.pageSub}>
            System configuration panels for analyst review, notifications, strict mode, and interface preferences. The appearance theme is user-controlled and persists between visits.
          </p>
        </div>
        <div className={layout.pill}>
          <SettingsIcon className={styles.smallIcon} />
          <span>Configuration center</span>
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

          <div className={styles.toggleList}>
            <ToggleRow
              title="Analyst review"
              description="Require a human reviewer for inconclusive or sensitive detections."
              checked={analystReview}
              onChange={() => setAnalystReview((prev) => !prev)}
            />
            <ToggleRow
              title="Notifications"
              description="Notify operators about detections, policy events, and sync issues."
              checked={notifications}
              onChange={() => setNotifications((prev) => !prev)}
            />
            <ToggleRow
              title="Strict mode"
              description="Increase sensitivity for high-risk sources and suspicious uploads."
              checked={strictMode}
              onChange={() => setStrictMode((prev) => !prev)}
            />
            <ToggleRow
              title="Auto-sync global database"
              description="Keep threat fingerprints and moderation policies aligned automatically."
              checked={autoSync}
              onChange={() => setAutoSync((prev) => !prev)}
            />
          </div>

          <div className={styles.sliderBlock}>
            <div className={styles.sliderHeader}>
              <strong>Auto-block threshold</strong>
              <span>{threshold}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="99"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              className={styles.range}
            />
            <div className={styles.sliderFoot}>
              <span>Cautious</span>
              <span>Aggressive</span>
            </div>
          </div>
        </article>

        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Appearance</div>
              <div className={layout.panelSub}>Choose the light or dark theme for the system UI</div>
            </div>
          </div>

          <div className={styles.themeChooser}>
            <button
              type="button"
              onClick={() => setTheme && setTheme("light")}
              className={theme === "light" ? `${styles.themeCard} ${styles.themeCardActive}` : styles.themeCard}
            >
              <SunIcon className={styles.themeIcon} />
              <strong>Light Theme</strong>
              <span>Bright background with softer contrast</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme && setTheme("dark")}
              className={theme === "dark" ? `${styles.themeCard} ${styles.themeCardActive}` : styles.themeCard}
            >
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

      <section className={styles.configGrid}>
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
          <div className={styles.hintBox}>
            Keep the API key private and rotate it if access is shared or exposed.
          </div>
        </article>

        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Retention & Audit</div>
              <div className={layout.panelSub}>Operational policy details for this environment</div>
            </div>
          </div>
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
