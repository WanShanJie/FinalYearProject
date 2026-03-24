const API_BASE = "http://127.0.0.1:8000";
const FRONTEND_BASE = "http://localhost:5173";
const DASHBOARD_URL = `${FRONTEND_BASE}/dashboard`;
const MEDIA_ANALYSIS_URL = `${FRONTEND_BASE}/media-analysis`;
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

// Result Block Elements
const analysisResultBlock = document.getElementById("analysisResultBlock");
const resVerdictBadge = document.getElementById("resVerdictBadge");
const resRiskBadge = document.getElementById("resRiskBadge");
const resReason = document.getElementById("resReason");
const resAction = document.getElementById("resAction");

let pollTimer = null;
let isRedeeming = false;

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

function stopLinkPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleLinkPoll(delayMs = 2000) {
  stopLinkPolling();
  pollTimer = setTimeout(() => {
    resumeLinkPolling().catch((err) => console.error("Polling error:", err));
  }, delayMs);
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

async function setDisconnectedState(message = "Link the extension once so all captures are stored under the correct signed-in portal account.") {
  stopLinkPolling();
  await chrome.storage.local.set({
    extensionToken: null,
    linkedUser: null,
    linkedDevice: null,
    extensionLinkStatus: "idle",
    extensionLinkError: "",
    extensionLinkRequestId: null,
    extensionCodeVerifier: null,
  });
  setConnectionVisual("idle", message);
}

async function refreshUI() {
  const st = await chrome.storage.local.get([
    "scanned",
    "blocked",
    "monitoringEnabled",
    "extensionToken",
    "linkedUser",
    "linkedDevice",
    "extensionLinkStatus",
    "extensionLinkError",
    "lastAnalysisId",
    "lastAnalysisVerdict",
    "lastAnalysisScore",
    "lastAnalysisMeta",
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
    
    if (st.lastAnalysisId) {
      updateResultUI(st.lastAnalysisVerdict, st.lastAnalysisScore, st.lastAnalysisMeta);
    } else {
      analyzeMsg.style.display = "block";
      analysisResultBlock.style.display = "none";
      analyzeMsg.textContent = "Run analysis to view verdict and reason.";
    }
    return;
  }

  btnDisconnectPortal.disabled = true;
  btnAnalyzeNow.disabled = false;

  if (st.extensionLinkStatus === "pending") {
    setConnectionVisual("pending", "Approve the request in the portal tab that just opened.");
    analyzeMsg.textContent = "Waiting for portal approval before analysis can be sent securely.";
    return;
  }

  if (st.extensionLinkStatus === "error") {
    setConnectionVisual("error", st.extensionLinkError || "Extension linking failed. Please try again.");
    analyzeMsg.style.display = "block";
    analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = "Connection failed. Fix the portal link first, then try analyzing again.";
    return;
  }

  setConnectionVisual("idle");
  analyzeMsg.style.display = "block";
  analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Connect the extension to the portal first. After linking, the simple result appears here and the full details appear in the portal.";
}

// ─── Shared Risk & Presentation Logic (Extension Mirror) ───────────────────
function getDisplayMetrics(backendVerdict, rawScore) {
  const v = (backendVerdict || "").toUpperCase();
  const raw = rawScore ?? 0;
  let riskScore = Math.round(raw * 100);

  let displayVerdict = v;
  if (!v || v === "UNKNOWN") {
    if (riskScore <= 29) displayVerdict = "REAL";
    else if (riskScore >= 70) displayVerdict = "FAKE";
    else displayVerdict = "INCONCLUSIVE";
  }

  let riskLevel = "Medium Risk";
  let scoreTone = "amber";
  if (riskScore <= 29) { riskLevel = "Low Risk"; scoreTone = "green"; }
  else if (riskScore >= 70) { riskLevel = "High Risk"; scoreTone = "red"; }

  if (displayVerdict === "REAL") {
    riskLevel = (riskScore < 30) ? "Low Risk" : "Legitimate";
  }

  let verdictTone = "amber";
  if (displayVerdict === "REAL") verdictTone = "green";
  else if (displayVerdict === "FAKE") verdictTone = "red";

  if (displayVerdict === "REAL" && riskScore >= 50) scoreTone = "amber";
  else if (displayVerdict === "FAKE" && riskScore < 50) scoreTone = "amber";

  return { riskScore, displayVerdict, riskLevel, tone: verdictTone, scoreTone };
}

function getPolicyAction(displayVerdict, riskScore) {
  if (displayVerdict === "FAKE") return { text: "Warning: Block or restrict sharing of this content.", tone: "red" };
  if (displayVerdict === "REAL") return { text: "Verified: No immediate action required.", tone: "green" };
  return { text: "Review carefully. Mixed or uncertain signals detected.", tone: "amber" };
}

function getReasoning(displayVerdict, riskScore) {
  if (displayVerdict === "REAL") return "Analysis found no significant evidence of digital manipulation.";
  if (displayVerdict === "FAKE") return "The AI model detected strong indicators of digital manipulation.";
  return "The analysis returned mixed or inconclusive signals, resulting in an uncertain classification.";
}

function updateResultUI(verdictRaw, rawScore, meta) {
  analyzeMsg.style.display = "none";
  analysisResultBlock.style.display = "block";

  const metrics = getDisplayMetrics(verdictRaw, rawScore);
  const policy = getPolicyAction(metrics.displayVerdict, metrics.riskScore);
  const reason = getReasoning(metrics.displayVerdict, metrics.riskScore);

  // 1. Verdict & Risk
  resVerdictBadge.textContent = metrics.displayVerdict;
  resVerdictBadge.className = `statusBadge ${
    metrics.tone === "green" ? "statusConnected" : metrics.tone === "red" ? "statusError" : "statusPending"
  }`;
  resRiskBadge.textContent = `${metrics.riskLevel} · ${metrics.riskScore}%`;
  resRiskBadge.className = `riskText ${metrics.tone}`;

  // 2. Identity
  const platform = meta?.platform || "Unknown";
  const mediaType = (meta?.media_type || "Media").charAt(0).toUpperCase() + (meta?.media_type || "Media").slice(1);
  const sourceId = meta?.video_id || meta?.current_video_id || (meta?.canonical_url ? meta.canonical_url.split('/').pop() : "...") ;

  document.getElementById("idtMediaType").textContent = mediaType;
  document.getElementById("idtPlatform").textContent = platform.charAt(0).toUpperCase() + platform.slice(1);
  document.getElementById("idtSource").textContent = sourceId;
  document.getElementById("idtSource").title = meta?.canonical_url || meta?.page_url || "";

  // 3. Narrative
  resReason.textContent = reason;
  resAction.textContent = policy.text;
  resAction.className = `resAction ${metrics.tone}`;
}

async function fetchLinkStatus(requestId) {
  const res = await fetch(`${API_BASE}/api/extension/link/request/${encodeURIComponent(requestId)}`);
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.detail || "Unable to load extension link status.");
  }
  return json;
}

async function redeemLinkRequest(requestId, codeVerifier) {
  const res = await fetch(`${API_BASE}/api/extension/link/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, code_verifier: codeVerifier }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.detail || "Unable to redeem extension link.");
  }
  await chrome.storage.local.set({
    extensionToken: json.extension_token,
    linkedUser: json.user || null,
    linkedDevice: json.device || null,
    extensionLinkStatus: "linked",
    extensionLinkError: "",
    extensionLinkRequestId: null,
    extensionCodeVerifier: null,
  });
  try {
    await chrome.runtime.sendMessage({ type: "EXTENSION_LINK_UPDATED" });
  } catch { }
  return json;
}

async function resumeLinkPolling() {
  const st = await chrome.storage.local.get([
    "extensionLinkStatus",
    "extensionLinkRequestId",
    "extensionCodeVerifier",
    "extensionToken",
  ]);

  if (st.extensionToken) {
    stopLinkPolling();
    await refreshUI();
    return;
  }

  if (st.extensionLinkStatus !== "pending" || !st.extensionLinkRequestId || !st.extensionCodeVerifier) {
    stopLinkPolling();
    return;
  }

  try {
    const status = await fetchLinkStatus(st.extensionLinkRequestId);

    if (status.status === "expired") {
      await chrome.storage.local.set({
        extensionLinkStatus: "error",
        extensionLinkError: "The link request expired. Please start the connection again.",
      });
      stopLinkPolling();
      await refreshUI();
      return;
    }

    if (status.status === "approved") {
      if (isRedeeming) return;
      isRedeeming = true;
      try {
        await redeemLinkRequest(st.extensionLinkRequestId, st.extensionCodeVerifier);
      } finally {
        isRedeeming = false;
      }
      stopLinkPolling();
      await refreshUI();
      analyzeMsg.textContent = "Extension linked successfully. You can analyze this page now.";
      return;
    }

    if (status.status === "redeemed") {
      await chrome.storage.local.set({
        extensionLinkStatus: "error",
        extensionLinkError: "This link request has already been used. Start a new connection from the extension popup.",
        extensionLinkRequestId: null,
        extensionCodeVerifier: null,
      });
      stopLinkPolling();
      await refreshUI();
      return;
    }

    await refreshUI();
    scheduleLinkPoll();
  } catch (err) {
    await chrome.storage.local.set({
      extensionLinkStatus: "error",
      extensionLinkError: err.message || "Failed to finish portal linking.",
    });
    stopLinkPolling();
    await refreshUI();
  }
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ monitoringEnabled: enabled });
  await sendToActiveTab({ type: "SET_MONITORING", enabled });
  await refreshUI();
});

btnAnalyzeNow.addEventListener("click", async () => {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) {
    analyzeMsg.style.display = "block";
    analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = "Connect the extension to the portal first.";
    await refreshUI();
    return;
  }

  analyzeMsg.style.display = "block";
  analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Capturing screen and sending to backend…";
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN_AND_SEND" });
  if (res?.ok) {
    await refreshUI();
  } else {
    analyzeMsg.style.display = "block";
    analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = `Failed: ${res?.detail || res?.error || "capture/send failed"}`;
    if (String(res?.error || "").includes("401")) {
      await setDisconnectedState("Portal link expired. Connect the extension again.");
      await refreshUI();
    }
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
      extensionCodeVerifier: codeVerifier,
      extensionLinkError: "",
      extensionToken: null,
      linkedUser: null,
      linkedDevice: null,
    });

    await chrome.tabs.create({ url: `${CONNECT_URL}?request_id=${encodeURIComponent(requestId)}` });
    await refreshUI();
    scheduleLinkPoll(1000);
  } catch (err) {
    await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: err.message || "Failed to connect extension." });
    await refreshUI();
  } finally {
    btnConnectPortal.disabled = false;
  }
});

btnDisconnectPortal.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "DISCONNECT_EXTENSION" });
  } catch { }
  await setDisconnectedState("Extension disconnected. Connect again to resume account-linked capture.");
  
  analyzeMsg.style.display = "block";
  analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Extension disconnected. Connect again to resume account-linked capture.";
  await refreshUI();
});

openDashboard.addEventListener("click", async (e) => {
  e.preventDefault();
  const { lastAnalysisId } = await chrome.storage.local.get(["lastAnalysisId"]);
  const url = lastAnalysisId ? `${MEDIA_ANALYSIS_URL}?analysis_id=${encodeURIComponent(lastAnalysisId)}` : DASHBOARD_URL;
  await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "COUNTS_UPDATED" || msg?.type === "EXTENSION_LINK_UPDATED") {
    refreshUI();
  }
});

(async function init() {
  await refreshUI();
  const st = await chrome.storage.local.get(["extensionLinkStatus", "extensionLinkRequestId", "extensionCodeVerifier", "extensionToken"]);
  if (!st.extensionToken && st.extensionLinkStatus === "pending" && st.extensionLinkRequestId && st.extensionCodeVerifier) {
    scheduleLinkPoll(1000);
  }
})();
