import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import styles from "./SystemLayout.module.css";
import { headerNav } from "../../data/systemMockData";
import logo from "../../assets/deepfake_logo.png";
import {
  BellIcon,
  DashboardIcon,
  ListIcon,
  LogoutIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SunIcon,
  UserIcon,
} from "./SystemIcons";

const iconMap = {
  dashboard: DashboardIcon,
  media: SearchIcon,
  blocklist: ListIcon,
  settings: SettingsIcon,
};

export default function SystemHeader({ theme, onToggleTheme }) {
  const navigate = useNavigate();
  const [user, setUser] = React.useState(null);

  React.useEffect(() => {
    try {
      const storedUser = localStorage.getItem("user");
      if (storedUser) {
        setUser(JSON.parse(storedUser));
      }
    } catch (e) {
      console.error("Error parsing user from localStorage", e);
    }
  }, []);

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    navigate("/signin", { replace: true });
  }

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
        {headerNav.map((item) => {
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

        <div className={styles.userProfile}>
          <div className={styles.userInfo}>
            <span className={styles.userName}>{user ? `${user.first_name || ""} ${user.last_name || ""}` : "User"}</span>
            <span className={styles.userRole}>Analyst</span>
          </div>
          <button className={styles.avatarButton} type="button" aria-label="User account">
            <UserIcon className={styles.actionIcon} />
          </button>
        </div>

        <button className={styles.logoutButton} type="button" onClick={logout}>
          <LogoutIcon className={styles.actionIcon} />
          <span>Logout</span>
        </button>
      </div>
    </header>
  );
}
