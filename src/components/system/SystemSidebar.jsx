import React from "react";
import styles from "./SystemLayout.module.css";
import { quickStats } from "../../data/systemMockData";
import { CalendarIcon, FilterIcon, MoonIcon, SearchIcon, SunIcon, SyncIcon } from "./SystemIcons";

export default function SystemSidebar({ theme, onToggleTheme }) {
  return (
    <aside className={styles.sidebar}>
      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Quick Stats</div>
        <div className={styles.sideStats}>
          {quickStats.map((item) => (
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
            <input className={styles.inputControl} placeholder="Select media" />
          </div>
        </label>

        <label className={styles.fieldWrap}>
          <span className={styles.fieldLabel}>Filter by Date</span>
          <div className={styles.inputShell}>
            <CalendarIcon className={styles.inputIcon} />
            <input className={styles.inputControl} placeholder="Select date range" />
          </div>
        </label>

        <label className={styles.fieldWrap}>
          <span className={styles.fieldLabel}>Verdict Status</span>
          <div className={styles.inputShell}>
            <FilterIcon className={styles.inputIcon} />
            <select className={styles.selectControl} defaultValue="All">
              <option>All</option>
              <option>Fake</option>
              <option>Real</option>
              <option>Inconclusive</option>
            </select>
          </div>
        </label>
      </section>

      <section className={styles.sideSection}>
        <div className={styles.sectionTitle}>Shortcuts</div>
        <button className={styles.sideButton} type="button">Extension Settings</button>
        <button className={styles.sideButton} type="button">
          <SyncIcon className={styles.shortcutIcon} />
          <span>Sync Database Now</span>
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
