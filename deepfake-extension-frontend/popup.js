const API_BASE = "http://127.0.0.1:8000";
const FRONTEND_BASE = "http://localhost:5173";
const DASHBOARD_URL = `${FRONTEND_BASE}/dashboard`;
const CONNECT_URL = `${FRONTEND_BASE}/extension/connect`;

const toggle = document.getElementById("toggleMonitoring");
const scannedCount = document.getElementById("scannedCount");
const blockedCount = document.getElementById("blockedCount");
const fpTitle = document.getElementById("fpTitle");
const fpSub = document.getElementById("fpSub");
const btnAnalyzeNow = document.getElementById("btnAnalyzeNow");
const analyzeMsg = document.getElementById("analyzeMsg");
const openDashboard = document.getElementById("openDashboard");
const btnConnectPortal = document.getElementById("btnConnectPortal");
const btnDisconnectPortal = document.getElementById("btnDisconnectPortal");
const connectedUser = document.getElementById("connectedUser");
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");
const linkStatusBadge = document.getElementById("linkStatusBadge");

async function sendToActiveTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return { ok: false };
  }
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function base64UrlEncode(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input) {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

function setConnectionVisual(state, detail = "") {
  connDot.classList.remove("connected", "error");
  linkStatusBadge.className = "statusBadge";

  if (state === "connected") {
    connDot.classList.add("connected");
    connText.textContent = "Connected";
    linkStatusBadge.classList.add("statusConnected");
    linkStatusBadge.textContent = "Connected";
    if (detail) connectedUser.textContent = detail;
    return;
  }

  if (state === "pending") {
    connText.textContent = "Pending";
    linkStatusBadge.classList.add("statusPending");
    linkStatusBadge.textContent = "Waiting approval";
    if (detail) connectedUser.textContent = detail;
    return;
  }

  if (state === "error") {
    connDot.classList.add("error");
    connText.textContent = "Issue";
    linkStatusBadge.classList.add("statusError");
    linkStatusBadge.textContent = "Action needed";
    if (detail) connectedUser.textContent = detail;
    return;
  }

  connText.textContent = "Ready";
  linkStatusBadge.classList.add("statusIdle");
  linkStatusBadge.textContent = "Not connected";
  connectedUser.textContent = detail || "Link the extension once so all captures are stored under the correct signed-in portal account.";
}

async function refreshUI() {
  const st = await chrome.storage.local.get([
    "scanned",
    "blocked",
    "monitoringEnabled",
    "extensionToken",
    "linkedUser",
    "extensionLinkStatus",
    "extensionLinkError",
  ]);

  scannedCount.textContent = st.scanned ?? 0;
  blockedCount.textContent = st.blocked ?? 0;

  const enabled = st.monitoringEnabled === true;
  toggle.checked = enabled;
  fpTitle.textContent = enabled ? "Fingerprint Matching Active" : "Protection Paused";
  fpSub.textContent = enabled
    ? "Monitoring pages for fingerprint matches…"
    : "Turn on Real-Time Protection to monitor media fingerprints.";

  if (st.extensionToken && st.linkedUser?.email) {
    setConnectionVisual("connected", `Linked as ${st.linkedUser.email}`);
    btnDisconnectPortal.disabled = false;
    btnAnalyzeNow.disabled = false;
    analyzeMsg.textContent = "Capture is ready. Results will appear in the portal under your account.";
    return;
  }

  btnDisconnectPortal.disabled = true;
  btnAnalyzeNow.disabled = false;

  if (st.extensionLinkStatus === "pending") {
    setConnectionVisual("pending", "Approve the request in the portal tab that just opened.");
    return;
  }

  if (st.extensionLinkStatus === "error") {
    setConnectionVisual("error", st.extensionLinkError || "Extension linking failed. Please try again.");
    return;
  }

  setConnectionVisual("idle");
  analyzeMsg.textContent = "Connect the extension to the portal first. After linking, the simple result appears here and the full details appear in the portal.";
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ monitoringEnabled: enabled });
  await sendToActiveTab({ type: "SET_MONITORING", enabled });
  await refreshUI();
});

btnAnalyzeNow.addEventListener("click", async () => {
  analyzeMsg.textContent = "Capturing screen and sending to backend…";
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN_AND_SEND" });
  if (res?.ok) {
    analyzeMsg.textContent = `Sent. analysis_id: ${res.analysis_id ?? "n/a"}`;
  } else {
    analyzeMsg.textContent = `Failed: ${res?.error || "capture/send failed"}`;
  }
});

btnConnectPortal.addEventListener("click", async () => {
  btnConnectPortal.disabled = true;
  try {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const codeVerifier = randomString(96);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    const res = await fetch(`${API_BASE}/api/extension/link/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        code_challenge: codeChallenge,
        device_name: "Chrome Extension",
        extension_version: chrome.runtime.getManifest().version,
      }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      throw new Error(json.detail || "Failed to create extension link request.");
    }

    await chrome.storage.local.set({
      extensionLinkStatus: "pending",
      extensionLinkRequestId: requestId,
      extensionLinkError: "",
      extensionToken: null,
    });

    await chrome.tabs.create({ url: `${CONNECT_URL}?request_id=${encodeURIComponent(requestId)}` });
    await chrome.runtime.sendMessage({ type: "BEGIN_EXTENSION_LINK_POLL", requestId, codeVerifier });
    await refreshUI();
  } catch (err) {
    await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: err.message || "Failed to connect extension." });
    await refreshUI();
  } finally {
    btnConnectPortal.disabled = false;
  }
});

btnDisconnectPortal.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "DISCONNECT_EXTENSION" });
  analyzeMsg.textContent = "Extension disconnected. Connect again to resume account-linked capture.";
  await refreshUI();
});

openDashboard.addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: DASHBOARD_URL });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "COUNTS_UPDATED" || msg?.type === "EXTENSION_LINK_UPDATED") {
    refreshUI();
  }
});

refreshUI();
