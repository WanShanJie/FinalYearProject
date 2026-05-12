import React, { useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import styles from "./SystemLayout.module.css";
import { CalendarIcon, FilterIcon, MoonIcon, SearchIcon, SunIcon, SyncIcon } from "./SystemIcons";

export default function SystemSidebar({ theme, onToggleTheme, sidebarStats = {} }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isSyncing, setIsSyncing] = useState(false);

  // Sync Database visually
  const handleSync = () => {
    setIsSyncing(true);
    // Dispatch a generic global sync event that pages can listen to for refetching
    window.dispatchEvent(new Event("force-sync"));
    setTimeout(() => setIsSyncing(false), 1000);
  };

  // Generic param updater
  const updateParam = (key, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) newParams.set(key, value);
    else newParams.delete(key);
    
    // If not on dashboard or media-analysis, redirect to media analysis so search works immediately
    if (!["/dashboard", "/media-analysis"].includes(location.pathname)) {
      navigate(`/media-analysis?${newParams.toString()}`);
    } else {
      setSearchParams(newParams);
    }
  };

  const { totalScans, threatsBlocked } = sidebarStats;
  const liveStats = [
    { label: "Total Scans", value: totalScans === null ? "—" : String(totalScans) },
    { label: "Threats Blocked", value: threatsBlocked === null ? "—" : String(threatsBlocked) },
  ];

  return (
    <aside className={styles.sidebar}>
      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Quick Stats</div>
        <div className={styles.sideStats}>
          {liveStats.map((item) => (
            <div className={styles.statCard} key={item.label}>
              <div className={styles.statLabel}>{item.label}</div>
              <div className={styles.statValue}>{item.value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Search & Filters</div>

        <label className={styles.fieldWrap}>
          <span className={styles.fieldLabel}>Search by Name or URL</span>
          <div className={styles.inputShell}>
            <SearchIcon className={styles.inputIcon} />
            <input 
              className={styles.inputControl} 
              placeholder="Select media" 
              value={searchParams.get("search") || ""}
              onChange={(e) => updateParam("search", e.target.value)}
            />
          </div>
        </label>

        <label className={styles.fieldWrap}>
          <span className={styles.fieldLabel}>Filter by Date</span>
          <div className={styles.inputShell}>
            <CalendarIcon className={styles.inputIcon} />
            <input 
              type="date"
              className={styles.inputControl} 
              style={{ colorScheme: theme }}
              value={searchParams.get("date") || ""}
              onChange={(e) => updateParam("date", e.target.value)}
            />
          </div>
        </label>

        <label className={styles.fieldWrap}>
          <span className={styles.fieldLabel}>Verdict Status</span>
          <div className={styles.inputShell}>
            <FilterIcon className={styles.inputIcon} />
            <select 
              className={styles.selectControl} 
              style={{ colorScheme: theme }}
              value={searchParams.get("verdict") || "All"}
              onChange={(e) => updateParam("verdict", e.target.value)}
            >
              <option value="All">All</option>
              <option value="Fake">Fake</option>
              <option value="Real">Real</option>
              <option value="Inconclusive">Inconclusive</option>
            </select>
          </div>
        </label>
      </section>

      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Shortcuts</div>
        <button className={styles.sideButton} type="button" onClick={() => navigate("/settings")}>
          Extension Settings
        </button>
        <button className={styles.sideButton} type="button" onClick={handleSync} disabled={isSyncing}>
          <SyncIcon className={styles.shortcutIcon} />
          <span>{isSyncing ? "Syncing..." : "Sync Database Now"}</span>
        </button>
      </section>

      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Appearance</div>
        <button className={styles.themeButton} type="button" onClick={onToggleTheme}>
          {theme === "dark" ? <SunIcon className={styles.shortcutIcon} /> : <MoonIcon className={styles.shortcutIcon} />}
          <span>{theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme"}</span>
        </button>
      </section>
    </aside>
  );
}
