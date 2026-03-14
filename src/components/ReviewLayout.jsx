import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import styles from "./ReviewLayout.module.css";
import { detectionStats } from "../data/reviewMockData";

const tabs = [
  {
    key: "analysis",
    label: "Media Analysis",
    subtitle: "Detailed decision review",
    to: "/media-analysis",
  },
  {
    key: "blocklist",
    label: "Blocklist Manager",
    subtitle: "Control moderation policy",
    to: "/blocklist-manager",
  },
  {
    key: "settings",
    label: "Settings",
    subtitle: "System and analyst controls",
    to: "/settings",
  },
];

export default function ReviewLayout({ activeTab, title, subtitle, children }) {
  const nav = useNavigate();

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    nav("/signin", { replace: true });
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>A2U</div>
          <div className={styles.brandSub}>Deepfake Verification</div>
        </div>

        <div className={styles.sectionTitle}>Review Workspace</div>
        <div className={styles.navList}>
          {tabs.map((tab) => (
            <NavLink
              key={tab.key}
              to={tab.to}
              className={({ isActive }) =>
                `${styles.navCard} ${isActive || activeTab === tab.key ? styles.navCardActive : ""}`.trim()
              }
            >
              <strong>{tab.label}</strong>
              <span>{tab.subtitle}</span>
            </NavLink>
          ))}
        </div>

        <div className={styles.sectionTitle}>Quick Stats</div>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <span>Today&apos;s Scans</span>
            <strong>{detectionStats.todayScans}</strong>
          </div>
          <div className={styles.statCard}>
            <span>Threats Blocked</span>
            <strong>{detectionStats.threatsBlocked}</strong>
          </div>
          <div className={styles.statCard}>
            <span>Under Review</span>
            <strong>{detectionStats.queueReview}</strong>
          </div>
        </div>

        <div className={styles.sectionTitle}>Shortcuts</div>
        <button className={styles.sideButton} type="button">Sync Database Now</button>
        <button className={styles.sideButtonAlt} type="button">Export Analyst Report</button>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.kicker}>Trust & Review Console</p>
            <h1>{title}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>

          <div className={styles.topActions}>
            <button className={styles.iconButton} type="button" aria-label="Notifications">
              🔔
            </button>
            <button className={styles.iconButton} type="button" aria-label="Profile">
              👤
            </button>
            <button className={styles.logoutButton} type="button" onClick={logout}>
              Logout
            </button>
          </div>
        </header>

        <nav className={styles.tabRow}>
          {tabs.map((tab) => (
            <NavLink
              key={tab.key}
              to={tab.to}
              className={({ isActive }) => `${styles.topTab} ${isActive ? styles.topTabActive : ""}`.trim()}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <section className={styles.content}>{children}</section>
      </main>
    </div>
  );
}
