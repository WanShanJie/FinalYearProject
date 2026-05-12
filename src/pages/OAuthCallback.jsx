import React, { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { saveSession } from "../api/auth";

export default function OAuthCallback() {
  const nav = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    const token = params.get("token");
    const error = params.get("error");

    if (error) {
      // Optional: show error screen, or redirect back
      nav(`/signin?error=${encodeURIComponent(error)}`, { replace: true });
      return;
    }

    if (!token) {
      nav("/signin?error=missing_token", { replace: true });
      return;
    }

    // Parse user from URL params if backend sends it; otherwise just store token.
    let userObj = null;
    const userParam = params.get("user");
    if (userParam) { try { userObj = JSON.parse(decodeURIComponent(userParam)); } catch { } }
    saveSession(token, userObj);

    // Check must_change_password in the JWT payload
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      if (payload.must_change_password) {
        nav("/change-password", { replace: true });
        return;
      }
    } catch { }

    nav("/dashboard", { replace: true });
  }, [nav, params]);

  return (
    <div style={{ padding: 24 }}>
      Logging you in...
    </div>
  );
}
