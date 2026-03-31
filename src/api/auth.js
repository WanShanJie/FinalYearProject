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

// ── Async video analysis (Celery task queue) ─────────────────────────────────

/**
 * Submit a video file for background deepfake analysis.
 * Returns immediately with { ok, analysis_id, status: "queued" }.
 * Use getAnalysisStatus() or submitAndPoll() to track progress.
 *
 * @param {File}   videoFile
 * @param {object} opts  - { title, platform, page_url }
 */
export async function submitVideoAnalysis(videoFile, { title = "", platform = "", page_url = "" } = {}) {
  const form = new FormData();
  form.append("file", videoFile);
  if (title)    form.append("title", title);
  if (platform) form.append("platform", platform);
  if (page_url) form.append("page_url", page_url);

  // Do NOT set Content-Type header — the browser sets the multipart boundary.
  const res = await fetch(`${API_BASE}/api/analysis/video`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  return handleResponse(res);
}

/**
 * Poll the status of a single analysis.
 * @param {number} analysisId
 * @returns {{ ok, analysis_id, status, progress?, verdict?, score?, reason? }}
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
