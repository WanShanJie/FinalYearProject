import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import layout from "../components/system/SystemLayout.module.css";
import styles from "./Settings.module.css";
import { LockIcon } from "../components/system/SystemIcons";
import { setInitialPassword, saveSession } from "../api/auth";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter";
import { isStrongPassword } from "../utils/passwordStrength";

function isForced() {
  try {
    const token = localStorage.getItem("token");
    if (!token) return false;
    const payload = JSON.parse(atob(token.split(".")[1]));
    return !!payload.must_change_password;
  } catch { return false; }
}

export default function ChangePassword() {
  const nav = useNavigate();
  const forced = isForced();

  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    if (!isStrongPassword(password)) {
      setError("Password does not meet the strength requirements shown below.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    try {
      setLoading(true);
      const result = await setInitialPassword(password);
      saveSession(result.token, result.user, result.role);
      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err?.message || "Failed to update password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={layout.page}>
      <section className={`${layout.heroPanel} ${layout.pageHeading}`}>
        <div>
          <div className={layout.pageTitle}>
            {forced ? "Set Your Password" : "Change Password"}
          </div>
          <p className={layout.pageSub}>
            {forced
              ? "Your account was provisioned by an admin. Set a personal password before continuing."
              : "Update your account password."}
          </p>
        </div>
        <div className={layout.pill}>
          <LockIcon className={styles.smallIcon} />
          <span>Security</span>
        </div>
      </section>

      <article className={`${layout.settingCard} ${styles.settingPanel}`} style={{ maxWidth: 480 }}>
        {forced && (
          <div style={{ background: "#1e3a5f", border: "1px solid #3b82f6", borderRadius: 8, padding: "10px 14px", marginBottom: 20, fontSize: 13, color: "#93c5fd" }}>
            You must set a new password to continue. You cannot access other pages until this is done.
          </div>
        )}

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {error && (
            <div style={{ color: "var(--danger)", background: "var(--danger-soft)", padding: "10px 14px", borderRadius: 8, fontSize: 14 }}>
              {error}
            </div>
          )}

          <div>
            <label style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 6, display: "block" }}>
              New Password
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min 8 chars, upper, lower, number, symbol"
                maxLength={72}
                autoFocus
                required
                style={{ width: "100%", background: "var(--bg-elevated-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "12px 52px 12px 14px", borderRadius: 8, outline: "none", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
            <PasswordStrengthMeter password={password} />
          </div>

          <div>
            <label style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 6, display: "block" }}>
              Confirm Password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat new password"
              maxLength={72}
              required
              style={{ width: "100%", background: "var(--bg-elevated-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "12px 14px", borderRadius: 8, outline: "none", boxSizing: "border-box" }}
            />
            {confirm && password !== confirm && (
              <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>Passwords do not match.</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            <button
              type="submit"
              disabled={loading}
              style={{ background: "var(--primary)", color: "white", border: "none", padding: "12px 24px", borderRadius: 8, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.8 : 1 }}
            >
              {loading ? "Saving…" : "Set Password"}
            </button>
            {/* Only show Cancel if not forced — forced users cannot skip */}
            {!forced && (
              <button
                type="button"
                onClick={() => nav(-1)}
                disabled={loading}
                style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", padding: "12px 24px", borderRadius: 8, fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </article>
    </div>
  );
}
