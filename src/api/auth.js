const API_BASE = "http://127.0.0.1:8000";

function extractErrorMessage(data) {
  if (!data) return "Request failed";

  // FastAPI often returns: { detail: "msg" }
  if (typeof data.detail === "string") return data.detail;

  // FastAPI validation error: { detail: [ {loc, msg, type}, ... ] }
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((e) => {
        const field = Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : "field";
        return `${field}: ${e.msg}`;
      })
      .join("\n");
  }

  // Any other shape
  if (typeof data.message === "string") return data.message;

  try {
    return JSON.stringify(data);
  } catch {
    return "Request failed";
  }
}

async function handleResponse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-json response
  }

  if (!res.ok) {
    if (res.status === 401) {
      if (typeof window !== "undefined") {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        localStorage.removeItem("role");
        if (!window.location.pathname.startsWith("/signin")) {
          window.location.href = "/signin";
        }
      }
    }
    throw new Error(extractErrorMessage(data));
  }

  return data;
}

export async function registerUser(payload) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
  // const data = await res.json();
  // if (!res.ok) throw new Error(await parseError(res));
  // return res.json();
}

export async function loginUser(payload) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
  // const data = await res.json();
  // if (!res.ok) throw new Error(data.detail || "Login failed");
  // return data;
}

export async function forgotPassword(email) {
  const res = await fetch("http://127.0.0.1:8000/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return handleResponse(res);
  // const data = await res.json();
  // if (!res.ok) throw new Error(data.detail || "Failed");
  // return data;
}

export async function resetPassword(token, newPassword) {
  const res = await fetch("http://127.0.0.1:8000/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  return handleResponse(res);
  // const data = await res.json();
  // if (!res.ok) throw new Error(data.detail || "Failed");
  // return data;
}


export async function verifyMfa(payload) {
  const res = await fetch(`${API_BASE}/api/auth/mfa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), // { mfa_token, code }
  });
  return handleResponse(res);
}

export async function verifyEmailOtp(payload) {
  // payload: { email, code, device_id, trust_device }
  const res = await fetch(`${API_BASE}/api/auth/verify-email-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
}

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Session helpers ───────────────────────────────────────────────────────────
// Always clear the previous user's data before writing a new session.
// This prevents cross-user data leakage when two accounts share the same browser.

export function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("role");
  // Dispatch a storage event so other open tabs (same origin) detect the change.
  window.dispatchEvent(new Event("session-changed"));
}

export function saveSession(token, user, role) {
  // Wipe any previous session first so stale data can never bleed through.
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("role");
  localStorage.setItem("token", token);
  if (user) localStorage.setItem("user", JSON.stringify(user));
  // Store role from response payload (or decode from JWT as fallback)
  const resolvedRole = role || getRoleFromToken(token) || "USER";
  localStorage.setItem("role", resolvedRole);
  window.dispatchEvent(new Event("session-changed"));
}

/**
 * Decode the role from the JWT payload without a library.
 * Returns "USER" | "ADMIN" | null.
 */
export function getRoleFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || null;
  } catch {
    return null;
  }
}

/** Convenience: returns the stored role string or "USER" as default. */
export function getStoredRole() {
  return localStorage.getItem("role") || "USER";
}

export async function getAdminStats() {
  const res = await fetch(`${API_BASE}/api/admin/stats`, {
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function getAdminLogs(limit = 20) {
  const res = await fetch(`${API_BASE}/api/admin/logs?limit=${limit}`, {
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function getAdminHealth() {
  const res = await fetch(`${API_BASE}/api/admin/health`, {
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function getAdminInfra() {
  const res = await fetch(`${API_BASE}/api/admin/infra`, { headers: authHeaders() });
  return handleResponse(res);
}
export async function getAdminPipeline() {
  const res = await fetch(`${API_BASE}/api/admin/pipeline`, { headers: authHeaders() });
  return handleResponse(res);
}
export async function getAdminTraffic() {
  const res = await fetch(`${API_BASE}/api/admin/traffic`, { headers: authHeaders() });
  return handleResponse(res);
}
export async function getAdminModelAnalytics() {
  const res = await fetch(`${API_BASE}/api/admin/model-analytics`, { headers: authHeaders() });
  return handleResponse(res);
}
export async function getAdminDowntime(range = "24h") {
  const res = await fetch(`${API_BASE}/api/admin/downtime?range=${range}`, {
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function getAdminMetricsHistory(range = "1h", start = null, end = null) {
  let url = `${API_BASE}/api/admin/metrics/history?range=${range}`;
  if (start && end) {
    url += `&start_ts=${encodeURIComponent(start)}&end_ts=${encodeURIComponent(end)}`;
  }
  const res = await fetch(url, { headers: authHeaders() });
  return handleResponse(res);
}

// ── Async video analysis (Celery task queue) ──────────────────────────────────

/**
 * Upload a video for background deepfake analysis.
 * Returns immediately with { analysis_id, status: "queued" } — does NOT wait
 * for the pipeline to finish.  Use getAnalysisStatus() to poll for results.
 *
 * @param {File}   file      - Video file object from an <input type="file">
 * @param {object} meta      - Optional metadata: { title, platform, page_url }
 * @returns {Promise<{ok, analysis_id, task_id, status, poll_url}>}
 */
export async function submitVideoAnalysis(file, meta = {}) {
  const form = new FormData();
  form.append("file", file);
  if (meta.title)    form.append("title",    meta.title);
  if (meta.platform) form.append("platform", meta.platform);
  if (meta.page_url) form.append("page_url", meta.page_url);

  const res = await fetch(`${API_BASE}/api/analysis/video`, {
    method: "POST",
    headers: authHeaders(),   // no Content-Type — browser sets multipart boundary
    body: form,
  });
  return handleResponse(res);
}

/**
 * Poll the status of a queued / in-progress analysis job.
 *
 * @param {number} analysisId
 * @returns {Promise<{
 *   ok, analysis_id, status,
 *   progress?, stage?,          // while PROCESSING
 *   verdict?, score?, reason?,  // when DONE
 *   error?,                     // when ERROR
 * }>}
 */
export async function getAnalysisStatus(analysisId) {
  const res = await fetch(`${API_BASE}/api/analysis/${analysisId}/status`, {
    headers: authHeaders(),
  });
  return handleResponse(res);
}

/**
 * Submit a video and poll until analysis completes or fails.
 *
 * @param {File}   videoFile
 * @param {object} opts                           - passed to submitVideoAnalysis
 * @param {object} callbacks
 *   onQueued(analysisId)                         - fired right after submission
 *   onProgress({ progress: 0-100, stage: str }) - fired each poll while processing
 *   onDone(statusPayload)                        - fired when status === "DONE"
 *   onError(statusPayload | Error)               - fired on ERROR or network failure
 * @param {number} intervalMs                     - polling interval in ms (default 3000)
 */
export async function submitAndPoll(
  videoFile,
  opts = {},
  { onQueued, onProgress, onDone, onError } = {},
  intervalMs = 3000,
) {
  let analysisId;

  try {
    const queued = await submitVideoAnalysis(videoFile, opts);
    analysisId = queued.analysis_id;
    onQueued?.(analysisId);
  } catch (err) {
    onError?.(err);
    return;
  }

  const _poll = async () => {
    try {
      const status = await getAnalysisStatus(analysisId);

      if (status.status === "DONE") {
        onDone?.(status);
        return;
      }
      if (status.status === "ERROR") {
        onError?.(status);
        return;
      }

      // Still PENDING or PROCESSING — report progress and reschedule
      if (status.status === "PROCESSING") {
        onProgress?.({ progress: status.progress ?? 0, stage: status.stage ?? "" });
      }
      setTimeout(_poll, intervalMs);
    } catch (err) {
      onError?.(err);
    }
  };

  setTimeout(_poll, intervalMs);
}

// ── User / Admin API ──────────────────────────────────────────────────────────

export async function getMe() {
  const res = await fetch(`${API_BASE}/api/me`, { headers: authHeaders() });
  return handleResponse(res);
}

export async function updateProfile(payload) {
  const res = await fetch(`${API_BASE}/api/me`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
}

export async function listUsers() {
  const res = await fetch(`${API_BASE}/api/admin/users`, { headers: authHeaders() });
  return handleResponse(res);
}

export async function approveUser(userId) {
  const res = await fetch(`${API_BASE}/api/admin/users/${userId}/approve`, {
    method: "POST",
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function revokeUser(userId) {
  const res = await fetch(`${API_BASE}/api/admin/users/${userId}/revoke`, {
    method: "POST",
    headers: authHeaders(),
  });
  return handleResponse(res);
}

export async function setUserRole(userId, role) {
  const res = await fetch(`${API_BASE}/api/admin/users/${userId}/set-role`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ role }),
  });
  return handleResponse(res);
}

export async function createAdminUser(payload) {
  // payload: { email, first_name, last_name, role }
  const res = await fetch(`${API_BASE}/api/admin/users/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
}

export async function setInitialPassword(newPassword) {
  const res = await fetch(`${API_BASE}/api/auth/set-initial-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ new_password: newPassword }),
  });
  return handleResponse(res);
}

