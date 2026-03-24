import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";
import { loginUser } from "../api/auth";
import { getDeviceId } from "../utils/devices";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function SignIn() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      setLoading(true);
      // Google OAuth users still go straight in (receive token), Local users go to /mfa
      const result = await loginUser({ email, password, device_id: getDeviceId() });

      if (result.verification_required) {
        sessionStorage.setItem("pending_verify_email", email);
        nav("/verify-email", { replace: true });
        return;
      }

      if (result.mfa_required) {
        sessionStorage.setItem("mfa_token", result.mfa_token);
        sessionStorage.setItem("mfa_email", email);
        nav("/mfa", { replace: true });
        return;
      }

      // trusted device -> direct login
      localStorage.setItem("token", result.token);
      localStorage.setItem("user", JSON.stringify(result.user));
      nav("/dashboard", { replace: true });

    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function loginWithGoogle() {
    window.location.href = `${BACKEND}/api/oauth/google/login`;
  }

  // function loginWithX() {
  //   window.location.href = `${BACKEND}/api/oauth/x/login`;
  // }


  return (
    <AuthLayout title="Sign In" subtitle="Enter your email and password to sign in">
      {error ? <div style={{ color: "red", marginBottom: 12 }}>{error}</div> : null}

      <div className={form.socialGrid}>
        <button type="button" className={form.socialBtn} onClick={loginWithGoogle}>
          <GoogleIcon /> Sign in with Google
        </button>
        {/* <button type="button" className={form.socialBtn} onClick={loginWithX}>
          <XIcon /> Sign in with X
        </button> */}
      </div>

      <div className={form.divider}>
        <div className={form.dividerLine} />
        <span className={form.dividerText}>Or</span>
        <div className={form.dividerLine} />
      </div>

      <form className={form.form} onSubmit={onSubmit}>
        <div>
          <div className={form.label}>Email*</div>
          <input
            className={form.input}
            type="email"
            placeholder="info@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div>
          <div className={form.label}>Password*</div>
          <div className={form.passwordWrap}>
            <input
              className={form.passwordInput}
              type={showPw ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className={form.eyeBtn}
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? "Hide" : "Show"}
            </button>
            <a href="/forgot-password" className={form.link}>Forgot password?</a>
          </div>
        </div>

        <button type="submit" className={form.primaryBtn} disabled={loading}>
          {loading ? "Signing in..." : "Sign In"}
        </button>

        <p className={form.bottomText}>
          Don&apos;t have an account? <a className={form.link} href="/signup">Sign Up</a>
        </p>
      </form>
    </AuthLayout>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.8 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.7 2.9l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.2-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3 0 5.7 1.1 7.7 2.9l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.7 0-14.3 4.3-17.7 10.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.2C29.3 36 26.8 37 24 37c-5.2 0-9.6-3.3-11.2-8l-6.6 5.1C9.5 40.2 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.2 3.4-3.9 6-7.3 7.3l6.3 5.2C37 38.1 44 34 44 24c0-1.3-.1-2.2-.4-3.5z" />
    </svg>
  );
}

// function XIcon() {
//   return (
//     <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
//       <path d="M18.9 2H22l-6.8 7.8L23 22h-6.8l-5.3-6.9L4.8 22H2l7.4-8.5L1 2h6.9l4.8 6.3L18.9 2zm-1.2 18h1.7L7.9 3.9H6.1L17.7 20z" />
//     </svg>
//   );
// }

function getErrorMessage(err) {
  // If backend returns {detail: "..."}
  if (err?.detail) return String(err.detail);

  // If you threw { message: "..." }
  if (err?.message) return String(err.message);

  // If fetch wrapper throws the whole JSON
  if (err && typeof err === "object") {
    if (err.error) return String(err.error);
    if (err.msg) return String(err.msg);
    // last resort:
    try {
      return JSON.stringify(err);
    } catch {
      return "Something went wrong. Please try again.";
    }
  }

  return String(err || "Something went wrong. Please try again.");
}
