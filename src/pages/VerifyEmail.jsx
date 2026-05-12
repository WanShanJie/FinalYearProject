import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";
import { verifyEmailOtp, saveSession } from "../api/auth";
import { getDeviceId } from "../utils/devices";

export default function VerifyEmail() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const email = sessionStorage.getItem("pending_verify_email") || "";

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    if (!email) {
      setError("Missing email. Please sign up again.");
      nav("/signup", { replace: true });
      return;
    }

    if (!code.trim()) {
      setError("Please enter the 6-digit code.");
      return;
    }

    try {
      setLoading(true);
      const result = await verifyEmailOtp({
        email,
        code: code.trim(),
        device_id: getDeviceId(),
        trust_device: true,
      });

      sessionStorage.removeItem("pending_verify_email");

      if (result.approval_required) {
        // Account verified but not yet approved — show message, don't issue token
        setError("");
        nav("/signin", {
          replace: true,
          state: { notice: result.message || "Email verified! Your account is pending admin approval." },
        });
        return;
      }

      saveSession(result.token, result.user, result.role);
      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err?.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Verify your email"
      subtitle={email ? `We sent a code to ${email}` : "Enter the code sent to your email"}
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
          />
        </div>

        <button className={form.submit} type="submit" disabled={loading}>
          {loading ? "Verifying..." : "Verify & Continue"}
        </button>

        <p style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
          Tip: Check spam/promotions. If you&apos;re testing locally, you can enable <b>DEV_PRINT_EMAILS=true</b> in backend .env to print the code.
        </p>
      </form>
    </AuthLayout>
  );
}
