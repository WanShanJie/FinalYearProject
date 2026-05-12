import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession, getStoredRole, getMe, saveSession } from "../../api/auth";
import styles from "./UserMenu.module.css";
import { 
  LogoutIcon, 
  SettingsIcon, 
  UserIcon, 
  LockIcon, 
} from "./SystemIcons";


export default function UserMenu({ user: initialUser }) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [user, setUser] = useState(initialUser);
  const menuRef = useRef(null);
  const role = getStoredRole();

  useEffect(() => {
    setUser(initialUser);
  }, [initialUser]);

  useEffect(() => {
    async function loadFullProfile() {
      try {
        const fullProfile = await getMe();
        if (fullProfile?.user) {
          setUser(fullProfile.user);
          // Gently update localStorage so the whole app stays synced
          saveSession(localStorage.getItem("token"), fullProfile.user, fullProfile.user.role);
        }
      } catch (err) {
        console.error("Failed to load backend profile details", err);
      }
    }
    loadFullProfile();
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleLogout() {
    clearSession();
    navigate("/signin", { replace: true });
  }

  function handleNav(path) {
    setIsOpen(false);
    navigate(path);
  }

  const displayName = user ? `${user.first_name || ""} ${user.last_name || ""}`.trim() || "User" : "User";
  const displayEmail = user?.email || "";
  
  // Create initials for avatar (e.g. "John Doe" -> "JD")
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase() || "U";

  return (
    <div className={`${styles.menuContainer} ${isOpen ? styles.open : ""}`} ref={menuRef}>
      <button 
        className={styles.avatarButton} 
        onClick={() => setIsOpen(!isOpen)}
        aria-label="User profile menu"
        aria-expanded={isOpen}
      >
        <div className={styles.avatarCircle}>{initials}</div>
      </button>

      {isOpen && (
        <div className={styles.dropdownMenu}>
          {/* Top section: User info */}
          <div className={styles.userInfoSection}>
            <div className={styles.avatarLarge}>{initials}</div>
            <div className={styles.userDetails}>
              <div className={styles.userName}>{displayName}</div>
              {displayEmail && <div className={styles.userEmail}>{displayEmail}</div>}
              <div className={styles.badgeRole}>
                {role === "ADMIN" ? "Admin" : "Analyst"}
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          {/* Main actions */}
          <div className={styles.menuGroup}>
            <button className={styles.menuItem} onClick={() => handleNav("/profile")}>
              <UserIcon className={styles.itemIcon} />
              My Profile
            </button>
            <button className={styles.menuItem} onClick={() => handleNav("/profile/security")}>
              <LockIcon className={styles.itemIcon} />
              Change Password
            </button>
          </div>

          <div className={styles.divider} />

          {/* System actions */}
          <div className={styles.menuGroup}>
            <button className={styles.menuItem} onClick={() => handleNav("/settings")}>
              <SettingsIcon className={styles.itemIcon} />
              Settings
            </button>
          </div>

          <div className={styles.divider} />

          {/* Logout */}
          <div className={styles.menuGroup}>
            <button className={`${styles.menuItem} ${styles.dangerItem}`} onClick={handleLogout}>
              <LogoutIcon className={styles.itemIcon} />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
