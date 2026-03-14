import React, { useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import SystemHeader from "./SystemHeader";
import SystemSidebar from "./SystemSidebar";
import styles from "./SystemLayout.module.css";

const THEME_KEY = "a2u-system-theme";

export default function SystemLayout() {
  const [theme, setTheme] = useState("dark");

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

  const contextValue = useMemo(() => ({ theme, setTheme }), [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }

  return (
    <div className={styles.shell} data-theme={theme}>
      <SystemHeader theme={theme} onToggleTheme={toggleTheme} />
      <SystemSidebar theme={theme} onToggleTheme={toggleTheme} />

      <main className={styles.mainContent}>
        <div className={styles.contentInner}>
          <Outlet context={contextValue} />
        </div>
      </main>
    </div>
  );
}
