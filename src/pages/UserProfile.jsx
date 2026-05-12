import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Settings.module.css"; // Reuse the layout of settings
import { getMe, updateProfile, saveSession } from "../api/auth";
import { UserIcon, CheckIcon } from "../components/system/SystemIcons";
import ChangePassword from "./ChangePassword";

export default function UserProfile() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState("general");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");

  useEffect(() => {
    // Check if the URL wants us to immediately hit the security tab
    if (location.pathname.includes("/security")) {
      setActiveTab("security");
    } else if (location.pathname.includes("/edit")) {
      setActiveTab("general");
    }
  }, [location.pathname]);

  async function loadProfile() {
    try {
      setLoading(true);
      const res = await getMe();
      if (res?.user) {
        setFirstName(res.user.first_name || "");
        setLastName(res.user.last_name || "");
        setEmail(res.user.email || "");
        setRole(res.user.role || "");
      }
    } catch (err) {
      setError(err.message || "Failed to load profile details.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProfile();
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    try {
      setSaving(true);
      const res = await updateProfile({ first_name: firstName, last_name: lastName });
      setSuccess("Profile updated successfully!");
      if (res?.user) {
        // Update local session storage
        const token = localStorage.getItem("token");
        saveSession(token, res.user, res.user.role);
      }
      setTimeout(() => setSuccess(""), 4000);
    } catch (err) {
      setError(err.message || "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className={layout.page}><div style={{ padding: 24, paddingLeft: 0 }}>Loading profile...</div></div>;
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>Your Profile</div>
          <p className={layout.pageSub}>
            Manage your personal information and adjust your security credentials.
          </p>
        </div>
        <div className={layout.pill}>
          <UserIcon className={styles.smallIcon} style={{ width: 16, height: 16, marginRight: 6 }} />
          <span>{role === "ADMIN" ? "Administrator" : "Analyst"}</span>
        </div>
      </section>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 16, borderBottom: "1px solid var(--border)", paddingBottom: 0, marginBottom: 16 }}>
        <button
          onClick={() => setActiveTab("general")}
          style={{
            background: "none", border: "none", borderBottom: activeTab === "general" ? "2px solid var(--primary)" : "2px solid transparent",
            color: activeTab === "general" ? "var(--text)" : "var(--muted)", padding: "10px 4px", fontSize: "0.95rem", fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
          }}
        >
          General Info
        </button>
        <button
          onClick={() => setActiveTab("security")}
          style={{
            background: "none", border: "none", borderBottom: activeTab === "security" ? "2px solid var(--primary)" : "2px solid transparent",
            color: activeTab === "security" ? "var(--text)" : "var(--muted)", padding: "10px 4px", fontSize: "0.95rem", fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
          }}
        >
          Password & Security
        </button>
      </div>

      {activeTab === "general" ? (
        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Personal Details</div>
              <div className={layout.panelSub}>Update your name so your team can recognize you</div>
            </div>
          </div>

          <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 20, paddingTop: 12 }}>
            {error && <div style={{ color: "var(--danger)", background: "var(--danger-soft)", padding: "10px 14px", borderRadius: 8 }}>{error}</div>}
            {success && <div style={{ color: "var(--success)", background: "var(--success-soft)", padding: "10px 14px", borderRadius: 8, display: "flex", alignItems: "center", gap: 8 }}><CheckIcon style={{width: 18, height: 18}}/> {success}</div>}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div className={styles.formGroup}>
                <label style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 6, display: "block" }}>First Name</label>
                <div className={styles.inputRow}>
                  <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" required style={{ width: "100%", background: "var(--bg-elevated-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 14px", borderRadius: 8, outline: "none" }} />
                </div>
              </div>
              
              <div className={styles.formGroup}>
                <label style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 6, display: "block" }}>Last Name</label>
                <div className={styles.inputRow}>
                  <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Doe" required style={{ width: "100%", background: "var(--bg-elevated-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 14px", borderRadius: 8, outline: "none" }} />
                </div>
              </div>
            </div>

            <div className={styles.formGroup}>
              <label style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 6, display: "block" }}>Email Address</label>
              <div className={styles.inputRow}>
                <input type="email" value={email} disabled style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", color: "var(--muted)", padding: "10px 14px", borderRadius: 8, outline: "none", cursor: "not-allowed", opacity: 0.8 }} />
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 6 }}>Email cannot be changed directly. Contact an administrator.</div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button type="submit" disabled={saving} style={{ background: "var(--primary)", color: "white", border: "none", padding: "12px 24px", borderRadius: 8, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 8, opacity: saving ? 0.8 : 1 }}>
                {saving ? "Saving Changes..." : "Save Profile"}
              </button>
            </div>
          </form>
        </article>
      ) : (
        <article className={`${layout.settingCard} ${styles.settingPanel}`}>
          <div className={layout.panelHeader}>
            <div>
              <div className={layout.panelTitle}>Change Password</div>
              <div className={layout.panelSub}>Ensure your account is using a long, random password</div>
            </div>
          </div>
          
          <div style={{ paddingTop: 16 }}>
             {/* If we render ChangePassword natively, it uses AuthLayout which breaks SystemLayout! 
                 Wait, ChangePassword is a FULL page right now. Let's redirect or adapt it. */}
             <p style={{ color: "var(--muted)", marginBottom: 16 }}>
               For security reasons, updating your password requires you to enter your current credentials.
             </p>
             <a href="/change-password" style={{ display: "inline-block", background: "var(--bg-elevated-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 20px", borderRadius: 8, textDecoration: "none", fontWeight: 600 }}>
               Go to Security Portal
             </a>
          </div>
        </article>
      )}
    </div>
  );
}
