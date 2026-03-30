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
