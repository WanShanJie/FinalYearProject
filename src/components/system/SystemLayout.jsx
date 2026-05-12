import React, { useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import SystemHeader from "./SystemHeader";
import SystemSidebar from "./SystemSidebar";
import styles from "./SystemLayout.module.css";

const THEME_KEY = "a2u-system-theme";
const API_BASE = "http://127.0.0.1:8000";

export default function SystemLayout() {
  const [theme, setTheme] = useState("dark");
  const [sidebarStats, setSidebarStats] = useState({ totalScans: null, threatsBlocked: null });

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
      return;
    }
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(prefersDark ? "dark" : "light");
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  function fetchSidebarStats() {
    const token = localStorage.getItem("token");
    if (!token) { setSidebarStats({ totalScans: null, threatsBlocked: null }); return; }
    fetch(`${API_BASE}/api/analysis/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.ok && data.stats) {
          setSidebarStats({
            totalScans: data.stats.totalScans ?? 0,
            threatsBlocked: data.stats.threatsBlocked ?? 0,
          });
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    fetchSidebarStats();
    window.addEventListener("session-changed", fetchSidebarStats);
    window.addEventListener("storage", fetchSidebarStats);
    return () => {
      window.removeEventListener("session-changed", fetchSidebarStats);
      window.removeEventListener("storage", fetchSidebarStats);
    };
  }, []);

  const contextValue = useMemo(() => ({ theme, setTheme }), [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }

  return (
    <div className={styles.shell} data-theme={theme}>
      <SystemHeader theme={theme} onToggleTheme={toggleTheme} />
      <SystemSidebar theme={theme} onToggleTheme={toggleTheme} sidebarStats={sidebarStats} />

      <main className={styles.mainContent}>
        <div className={styles.contentInner}>
          <Outlet context={contextValue} />
        </div>
      </main>
    </div>
  );
}
