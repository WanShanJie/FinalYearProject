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
import BlocklistManager from "./pages/BlocklistManager";
import Settings from "./pages/Settings";
import SystemLayout from "./components/system/SystemLayout";

function RequireAuth({ children }) {
  const token = localStorage.getItem("token");
  return token ? children : <Navigate to="/signin" replace />;
}

function PublicOnly({ children }) {
  const token = localStorage.getItem("token");
  if (token) return <Navigate to="/dashboard" replace />;
  return children;
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

      {/* Protected */}
      <Route
        element={
          <RequireAuth>
            <SystemLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/media-analysis" element={<MediaAnalysis />} />
        <Route path="/blocklist-manager" element={<BlocklistManager />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      {/* Default */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />

    </Routes>
  );
}