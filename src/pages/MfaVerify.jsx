import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";
import { verifyMfa, saveSession } from "../api/auth";
import { getDeviceId } from "../utils/devices";

export default function MfaVerify() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    const mfa_token = sessionStorage.getItem("mfa_token");
    const email = sessionStorage.getItem("mfa_email") || "";

    if (!mfa_token) {
      setError("MFA session expired. Please sign in again.");
      nav("/signin", { replace: true });
      return;
    }

    try {
      setLoading(true);

      const result = await verifyMfa({
        mfa_token,
        code: code.trim(),
        device_id: getDeviceId(),
        trust_device: trustDevice,
      });

      // Clear MFA session data BEFORE saving the new session so that
      // PublicOnly doesn't race with the nav("/dashboard") call.
      sessionStorage.removeItem("mfa_token");
      sessionStorage.removeItem("mfa_email");

      saveSession(result.token, result.user || {}, result.role);

      // Mirror the SignIn flow: force-change password if required
      if (result.must_change_password) {
        nav("/change-password", { replace: true });
        return;
      }

      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err?.message || err?.response?.data?.detail || "Invalid code.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Verify it's you"
      subtitle="Enter the 6-digit code sent to your email"
    >
      {error ? <div style={{ color: "crimson", marginBottom: 12 }}>{error}</div> : null}

      <form className={form.form} onSubmit={onSubmit}>
        <div>
          <div className={form.label}>Verification code</div>
          <input
            className={form.input}
            inputMode="numeric"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            required
          />
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
          />
          Trust this device (no OTP next time)
        </label>

        <button type="submit" className={form.primaryBtn} disabled={loading}>
          {loading ? "Verifying..." : "Verify"}
        </button>
      </form>
    </AuthLayout>
  );
}