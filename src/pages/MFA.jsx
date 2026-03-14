import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AuthLayout from "../components/AuthLayout";
import form from "../shared/AuthForm.module.css";
import { verifyMfa } from "../api/auth";

export default function MFA() {
  const nav = useNavigate();
  const [params] = useSearchParams();

  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const cid = params.get("challenge_id") || "";
    const em = params.get("email") || "";
    if (!cid) {
      nav("/signin", { replace: true });
      return;
    }
    setChallengeId(cid);
    setEmail(em);
  }, [params, nav]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    if (!code.trim()) {
      setError("Please enter the verification code.");
      return;
    }

    try {
      setLoading(true);
      const result = await verifyMfa(Number(challengeId), code.trim());

      localStorage.setItem("token", result.token);
      localStorage.setItem("user", JSON.stringify(result.user));

      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Verify it's you" subtitle={email ? `We sent a code to ${email}` : "Enter the code sent to your email"}>
      <form className={form.form} onSubmit={onSubmit}>
        <div>
          <div className={form.label}>Verification code</div>
          <input
            className={form.input}
            inputMode="numeric"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>

        {error && <p style={{ color: "crimson", fontSize: 13, margin: 0 }}>{error}</p>}

        <button type="submit" className={form.primaryBtn} disabled={loading}>
          {loading ? "Verifying..." : "Verify"}
        </button>

        <p className={form.bottomText}>
          <a className={form.link} href="/signin">Back to Sign In</a>
        </p>
      </form>
    </AuthLayout>
  );
}
