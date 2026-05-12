import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { clearSession, getStoredRole } from "../../api/auth";
import styles from "./SystemLayout.module.css";
import logo from "../../assets/deepfake_logo.png";
import {
  BellIcon,
  DashboardIcon,
  ListIcon,
  LogoutIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "./SystemIcons";

import UserMenu from "./UserMenu";

const iconMap = {
  dashboard:  DashboardIcon,
  media:      SearchIcon,
  blocklist:  ListIcon,
  "admin-panel": DashboardIcon,
  monitoring: MonitorIcon,
};

export default function SystemHeader({ theme, onToggleTheme }) {
  const navigate = useNavigate();
  const [user, setUser] = React.useState(null);

  function readUser() {
    try {
      const storedUser = localStorage.getItem("user");
      setUser(storedUser ? JSON.parse(storedUser) : null);
    } catch {
      setUser(null);
    }
  }

  React.useEffect(() => {
    readUser();
    // Re-read user whenever another tab or the current tab changes the session
    // (saveSession / clearSession both dispatch "session-changed").
    window.addEventListener("session-changed", readUser);
    window.addEventListener("storage", readUser);
    return () => {
      window.removeEventListener("session-changed", readUser);
      window.removeEventListener("storage", readUser);
    };
  }, []);

  const [role, setRole] = React.useState(getStoredRole);

  React.useEffect(() => {
    function readRole() { setRole(getStoredRole()); }
    window.addEventListener("session-changed", readRole);
    window.addEventListener("storage", readRole);
    return () => {
      window.removeEventListener("session-changed", readRole);
      window.removeEventListener("storage", readRole);
    };
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.brandArea}>
        <img src={logo} alt="A2U Logo" className={styles.brandLogoImg} />
        <div>
          <div className={styles.brandMark}>A<sup>2</sup>U</div>
          <div className={styles.brandSub}>Context-Aware Deepfake Detection</div>
        </div>
      </div>

      <nav className={styles.navTabs} aria-label="Primary navigation">
        {/* Base nav items — visible to all authenticated users */}
        {[
          { label: "Dashboard",      to: "/dashboard",       key: "dashboard" },
          { label: "Media Analysis", to: "/media-analysis",  key: "media" },
          { label: "Blocklist",      to: "/blocklist-manager", key: "blocklist" },
          // Admin-only items
          ...(role === "ADMIN" ? [
            { label: "Admin Panel",  to: "/admin/panel",     key: "admin-panel" },
            { label: "Monitoring",   to: "/admin/monitoring", key: "monitoring" },
          ] : []),
        ].map((item) => {
          const Icon = iconMap[item.key] || DashboardIcon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? `${styles.navTab} ${styles.navTabActive}` : styles.navTab
              }
            >
              <Icon className={styles.navIcon} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className={styles.headerActions}>
        <button className={styles.iconButton} onClick={onToggleTheme} type="button" aria-label="Toggle theme">
          {theme === "dark" ? <SunIcon className={styles.actionIcon} /> : <MoonIcon className={styles.actionIcon} />}
        </button>

        <button className={styles.iconButton} type="button" aria-label="Notifications">
          <BellIcon className={styles.actionIcon} />
          <span className={styles.notificationDot} />
        </button>

        <UserMenu user={user} />
      </div>
    </header>
  );
}
