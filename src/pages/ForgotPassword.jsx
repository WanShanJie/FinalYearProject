import { useState } from "react";
import { forgotPassword } from "../api/auth";
import AuthLayout from "../components/AuthLayout";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      const res = await forgotPassword(email);
      setMsg(res.message);
    } catch (err) {
      setMsg(err.message);
    }
  }

  return (
    <AuthLayout title="Forgot Password" subtitle="Reset your password">
      <form onSubmit={handleSubmit}>
        <input
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit">Send Reset</button>
      </form>

      {msg && <p>{msg}</p>}

      {token && (
        <div style={{ marginTop: 20 }}>
          <code>{token}</code>
        </div>
      )}
    </AuthLayout>
  );
}
