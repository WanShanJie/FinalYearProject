import { Routes, Route, Navigate } from "react-router-dom";
import SignIn from "./pages/SignIn";
import SignUp from "./pages/SignUp";
import OAuthCallback from "./pages/OAuthCallback";
import Dashboard from "./pages/Dashboard";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import MfaVerify from "./pages/MfaVerify";
import VerifyEmail from "./pages/VerifyEmail";
import MediaAnalysis from "./pages/MediaAnalysis";
import MediaAnalysisDetail from "./pages/MediaAnalysisDetail";
import BlocklistManager from "./pages/BlocklistManager";
import Settings from "./pages/Settings";
import ExtensionConnect from "./pages/ExtensionConnect";
import AdminMonitoring from "./pages/AdminMonitoring";
import AdminInfra from "./pages/monitoring/AdminInfra";
import AdminPipeline from "./pages/monitoring/AdminPipeline";
import AdminTraffic from "./pages/monitoring/AdminTraffic";
import AdminModelAnalytics from "./pages/monitoring/AdminModelAnalytics";
import AdminPanel from "./pages/AdminPanel";
import ChangePassword from "./pages/ChangePassword";
import UserProfile from "./pages/UserProfile";
import SystemLayout from "./components/system/SystemLayout";
import { getStoredRole } from "./api/auth";

// ── Auth Guards ───────────────────────────────────────────────────────────────

function getMustChangePassword() {
  try {
    const token = localStorage.getItem("token");
    if (!token) return false;
    const payload = JSON.parse(atob(token.split(".")[1]));
    return !!payload.must_change_password;
  } catch { return false; }
}

function RequireAuth({ children }) {
  const token = localStorage.getItem("token");
  return token ? children : <Navigate to="/signin" replace />;
}

/**
 * Forces users with must_change_password=true to /change-password.
 * Wraps every protected route except /change-password itself.
 */
function RequirePasswordSet({ children }) {
  if (getMustChangePassword()) return <Navigate to="/change-password" replace />;
  return children;
}

function PublicOnly({ children }) {
  const token = localStorage.getItem("token");
  if (token) return <Navigate to="/dashboard" replace />;
  return children;
}

/** Redirect non-admins to /not-authorized (or /dashboard) */
function RequireAdmin({ children }) {
  const token = localStorage.getItem("token");
  if (!token) return <Navigate to="/signin" replace />;
  const role = getStoredRole();
  if (role !== "ADMIN") return <Navigate to="/not-authorized" replace />;
  return children;
}

/** Simple "Not Authorized" page rendered inline */
function NotAuthorized() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100vh",
      background: "#0f1117", color: "#e2e8f0", fontFamily: "Inter, sans-serif",
    }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>🔒</div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 8px" }}>Access Denied</h1>
      <p style={{ color: "#94a3b8", marginBottom: 24 }}>
        You do not have permission to view this page.
      </p>
      <a href="/dashboard" style={{
        padding: "10px 24px", background: "#3b82f6", color: "#fff",
        borderRadius: 8, textDecoration: "none", fontWeight: 600,
      }}>
        Go to Dashboard
      </a>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/signin" element={<PublicOnly><SignIn /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignUp /></PublicOnly>} />
      <Route path="/oauth/callback" element={<OAuthCallback />} />

      {/* ✅ OTP UIs must be public */}
      <Route path="/verify-email" element={<PublicOnly><VerifyEmail /></PublicOnly>} />
      <Route path="/mfa" element={<PublicOnly><MfaVerify /></PublicOnly>} />

      <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
      <Route path="/reset-password" element={<PublicOnly><ResetPassword /></PublicOnly>} />

      {/* Not authorized catch-all */}
      <Route path="/not-authorized" element={<NotAuthorized />} />

      {/* Protected — any authenticated user */}
      <Route
        element={
          <RequireAuth>
            <SystemLayout />
          </RequireAuth>
        }
      >
        {/* /change-password is exempt from RequirePasswordSet so the user can actually reach it */}
        <Route path="/change-password" element={<ChangePassword />} />

        {/* All other protected routes redirect to /change-password if password reset is required */}
        <Route path="/dashboard" element={<RequirePasswordSet><Dashboard /></RequirePasswordSet>} />
        <Route path="/media-analysis" element={<RequirePasswordSet><MediaAnalysis /></RequirePasswordSet>} />
        <Route path="/media-analysis/:analysisId" element={<RequirePasswordSet><MediaAnalysisDetail /></RequirePasswordSet>} />
        <Route path="/blocklist-manager" element={<RequirePasswordSet><BlocklistManager /></RequirePasswordSet>} />
        <Route path="/settings" element={<RequirePasswordSet><Settings /></RequirePasswordSet>} />
        <Route path="/extension/connect" element={<RequirePasswordSet><ExtensionConnect /></RequirePasswordSet>} />
        <Route path="/profile/*" element={<RequirePasswordSet><UserProfile /></RequirePasswordSet>} />

        {/* Admin-only routes */}
        <Route path="/admin/monitoring"          element={<RequireAdmin><RequirePasswordSet><AdminMonitoring /></RequirePasswordSet></RequireAdmin>} />
        <Route path="/admin/monitoring/infra"    element={<RequireAdmin><RequirePasswordSet><AdminInfra /></RequirePasswordSet></RequireAdmin>} />
        <Route path="/admin/monitoring/pipeline" element={<RequireAdmin><RequirePasswordSet><AdminPipeline /></RequirePasswordSet></RequireAdmin>} />
        <Route path="/admin/monitoring/traffic"  element={<RequireAdmin><RequirePasswordSet><AdminTraffic /></RequirePasswordSet></RequireAdmin>} />
        <Route path="/admin/monitoring/models"   element={<RequireAdmin><RequirePasswordSet><AdminModelAnalytics /></RequirePasswordSet></RequireAdmin>} />
        <Route path="/admin/panel"               element={<RequireAdmin><RequirePasswordSet><AdminPanel /></RequirePasswordSet></RequireAdmin>} />
      </Route>

      {/* Default */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />

    </Routes>
  );
}
