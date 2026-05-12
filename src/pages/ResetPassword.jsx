import React, { useEffect, useState } from "react";
import { resetPassword } from "../api/auth";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";
import { useNavigate, useSearchParams } from "react-router-dom";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter";
import { isStrongPassword } from "../utils/passwordStrength";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [token, setToken] = useState("");
  const [pw, setPw]       = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [msg, setMsg]         = useState("");
  const [isErr, setIsErr]     = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = params.get("token");
    if (t) setToken(t);
  }, [params]);

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg(""); setIsErr(false);

    if (!isStrongPassword(pw)) {
      setMsg("Password does not meet the strength requirements shown below.");
      setIsErr(true);
      return;
    }
    if (pw !== confirm) {
      setMsg("Passwords do not match.");
      setIsErr(true);
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, pw);
      setMsg("Password reset successful! Redirecting to sign in…");
      setTimeout(() => nav("/signin", { state: { notice: "Password updated. Please sign in." } }), 1800);
    } catch (err) {
      setMsg(err.message || "Reset failed. The link may have expired.");
      setIsErr(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Reset Password" subtitle="Enter a new strong password for your account.">
      {msg && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 14,
          background: isErr ? "#450a0a" : "#052e16",
          border: `1px solid ${isErr ? "#ef4444" : "#22c55e"}`,
          color: isErr ? "#fca5a5" : "#86efac",
        }}>
          {msg}
        </div>
      )}

      <form className={form.form} onSubmit={handleSubmit}>
        {!params.get("token") && (
          <div>
            <div className={form.label}>Reset Token</div>
            <input
              className={form.input}
              placeholder="Paste the token from your email"
              value={token}
              onChange={e => setToken(e.target.value)}
              required
            />
          </div>
        )}

        <div>
          <div className={form.label}>New Password</div>
          <div className={form.passwordWrap}>
            <input
              className={form.passwordInput}
              type={showPw ? "text" : "password"}
              placeholder="Min 8 chars, upper, lower, number, symbol"
              value={pw}
              onChange={e => setPw(e.target.value)}
              maxLength={72}
              required
            />
            <button type="button" className={form.eyeBtn} onClick={() => setShowPw(v => !v)}>
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          <PasswordStrengthMeter password={pw} />
        </div>

        <div>
          <div className={form.label}>Confirm Password</div>
          <input
            className={form.input}
            type="password"
            placeholder="Repeat new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            maxLength={72}
            required
          />
          {confirm && pw !== confirm && (
            <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>Passwords do not match.</div>
          )}
        </div>

        <button type="submit" className={form.primaryBtn} disabled={loading}>
          {loading ? "Resetting…" : "Reset Password"}
        </button>

        <p className={form.bottomText}>
          Remembered it? <a className={form.link} href="/signin">Sign In</a>
        </p>
      </form>
    </AuthLayout>
  );
}
