import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { forgotPassword } from "../api/auth";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [isErr, setIsErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg("");
    setIsErr(false);
    setLoading(true);
    try {
      const res = await forgotPassword(email);
      setMsg(res.message || "Reset link sent! Check your inbox (and spam folder).");
      setSent(true);
    } catch (err) {
      setMsg(err.message || "Failed to send reset link. Please try again.");
      setIsErr(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Forgot Password"
      subtitle="Enter your account email and we'll send a reset link."
      onBack={() => navigate("/signin")}
    >
      {msg && (
        <div style={{
          padding: "10px 14px",
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 14,
          background: isErr ? "#fff1f2" : "#f0fdf4",
          border: `1px solid ${isErr ? "#fca5a5" : "#86efac"}`,
          color: isErr ? "#b91c1c" : "#15803d",
        }}>
          {msg}
        </div>
      )}

      {!sent ? (
        <form className={form.form} onSubmit={handleSubmit}>
          <div>
            <div className={form.label}>Email Address</div>
            <input
              className={form.input}
              type="email"
              placeholder="Enter your account email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <button type="submit" className={form.primaryBtn} disabled={loading}>
            {loading ? "Sending…" : "Send Reset Link"}
          </button>

          <p className={form.bottomText}>
            Remembered it?{" "}
            <a className={form.link} href="/signin">
              Sign In
            </a>
          </p>
        </form>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ fontSize: 14, color: "#475569", margin: 0, lineHeight: 1.6 }}>
            If this email is registered, you will receive a password reset link shortly.
            Please also check your <strong>spam / promotions</strong> folder.
          </p>
          <a className={form.link} href="/signin" style={{ fontSize: 14 }}>
            ← Back to Sign In
          </a>
        </div>
      )}
    </AuthLayout>
  );
}
