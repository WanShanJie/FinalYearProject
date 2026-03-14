import React, { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

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

    localStorage.setItem("token", token);
    // if backend also sends user JSON, you can parse it. For now token is enough.

    nav("/dashboard", { replace: true });
  }, [nav, params]);

  return (
    <div style={{ padding: 24 }}>
      Logging you in...
    </div>
  );
}
