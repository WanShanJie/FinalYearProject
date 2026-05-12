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
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch { return { ok: false }; }
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => (b % 36).toString(36)).join("");
}

function base64UrlEncode(bytes) {
  let binary = "";
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input) {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

let pollCount = 0;

// ── Popup-side analysis result polling ────────────────────────────────────────

let _analysisPollTimer = null;

function stopAnalysisPoll() {
  if (_analysisPollTimer) { clearTimeout(_analysisPollTimer); _analysisPollTimer = null; }
}

async function startAnalysisPoll(analysisId) {
  stopAnalysisPoll();
  let token = null;
  try {
    const st = await chrome.storage.local.get(["extensionToken", "extensionTokenMap"]);
    token = st.extensionToken;
    if (!token) {
      const map = st.extensionTokenMap || {};
      for (const e of Object.values(map)) { if (e?.token) { token = e.token; break; } }
    }
  } catch { }
  if (!token) return;

  const _poll = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/analysis/${analysisId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { _analysisPollTimer = setTimeout(_poll, 5000); return; }
      const s = await res.json();
      if (s.status === "DONE") {
        stopAnalysisPoll();
        await chrome.storage.local.set({
          lastAnalysisVerdict: s.verdict, lastAnalysisScore: s.score,
          lastAnalysisStatus: "DONE", lastAnalysisReason: s.reason || null,
          lastAnalysisConfidence: s.confidence || null,
        });
        updateResultUI(s.verdict, s.score, null, s.reason, s.confidence);
      } else if (s.status === "ERROR") {
        stopAnalysisPoll();
        await chrome.storage.local.set({ lastAnalysisStatus: "ERROR" });
        analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
        analyzeMsg.textContent = `Analysis failed: ${s.error || "Unknown error. Please retry."}`;
      } else {
        const prog = s.progress > 0 ? ` ${s.progress}%` : "";
        const stage = s.stage && s.stage !== "queued" ? ` (${s.stage})` : "";
        analyzeMsg.textContent = `Analyzing…${prog}${stage}`;
        _analysisPollTimer = setTimeout(_poll, 3000);
      }
    } catch { _analysisPollTimer = setTimeout(_poll, 5000); }
  };

  analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Analysis in progress…";
  _analysisPollTimer = setTimeout(_poll, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────

function stopLinkPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  pollCount = 0;
}

function scheduleLinkPoll(delayMs = 2000) {
  stopLinkPolling();
  pollCount++;
  if (pollCount > 60) {
    chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: "Request timed out after 2 minutes." }).then(() => {
        refreshUI();
    });
    return;
  }
  pollTimer = setTimeout(() => resumeLinkPolling().catch(err => console.error("Polling error:", err)), delayMs);
}

function setConnectionVisual(state, detail = "") {
  connDot.classList.remove("connected", "error");
  linkStatusBadge.className = "statusBadge";
  if (state === "connected") {
    connDot.classList.add("connected"); connText.textContent = "Connected";
    linkStatusBadge.classList.add("statusConnected"); linkStatusBadge.textContent = "Connected";
    if (detail) connectedUser.textContent = detail; return;
  }
  if (state === "pending") {
    connText.textContent = "Pending";
    linkStatusBadge.classList.add("statusPending"); linkStatusBadge.textContent = "Waiting approval";
    if (detail) connectedUser.textContent = detail; return;
  }
  if (state === "error") {
    connDot.classList.add("error"); connText.textContent = "Issue";
    linkStatusBadge.classList.add("statusError"); linkStatusBadge.textContent = "Action needed";
    if (detail) connectedUser.textContent = detail; return;
  }
  connText.textContent = "No Connection";
  linkStatusBadge.classList.add("statusIdle"); linkStatusBadge.textContent = "Not connected";
  connectedUser.textContent = detail || "Link the extension to the portal first.";
}

// ── Per-user token map helpers ────────────────────────────────────────────────

/**
 * Ask the content script on the active tab for the portal user currently
 * signed in there.  Returns { userId, email } or null if unavailable.
 */
async function getPortalUserFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_PORTAL_USER" });
    if (res?.ok && res?.userId) return { userId: res.userId, email: res.email || null };
  } catch { }
  return null;
}

/**
 * Return the stored entry { token, user, device } for the active tab's portal
 * user, or null if that user has not linked the extension yet.
 */
async function getActiveUserEntry() {
  const portalUser = await getPortalUserFromActiveTab();
  if (portalUser?.userId) {
    const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
    return (extensionTokenMap || {})[portalUser.userId] || null;
  }
  // Not on a portal tab — fall back to the legacy single-token slot so the
  // popup still works on non-portal pages.
  const st = await chrome.storage.local.get(["extensionToken", "linkedUser", "linkedDevice"]);
  if (st.extensionToken) return { token: st.extensionToken, user: st.linkedUser, device: st.linkedDevice };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

async function setDisconnectedState(message = "Link the extension to the portal first.") {
  stopLinkPolling();

  // Remove only this portal user's entry from the per-user map.
  const portalUser = await getPortalUserFromActiveTab();
  if (portalUser?.userId) {
    const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
    const map = extensionTokenMap || {};
    delete map[portalUser.userId];
    await chrome.storage.local.set({ extensionTokenMap: map });
  }

  // Also clear the legacy single-token slot and the linking-flow state.
  await chrome.storage.local.set({
    extensionToken: null, linkedUser: null, linkedDevice: null,
    extensionLinkStatus: "idle", extensionLinkError: "",
    extensionLinkRequestId: null, extensionCodeVerifier: null,
  });
  setConnectionVisual("idle", message);
}

async function refreshUI() {
  const st = await chrome.storage.local.get([
    "scanned", "blocked", "monitoringEnabled",
    "extensionTokenMap",
    "extensionLinkStatus", "extensionLinkError",
    "lastAnalysisId", "lastAnalysisVerdict", "lastAnalysisScore", "lastAnalysisMeta",
    "lastAnalysisStatus", "lastAnalysisReason", "lastAnalysisConfidence",
  ]);

  scannedCount.textContent = st.scanned ?? 0;
  blockedCount.textContent = st.blocked ?? 0;

  const enabled = st.monitoringEnabled === true;
  toggle.checked = enabled;
  fpTitle.textContent = enabled ? "Fingerprint Matching Active" : "Protection Paused";
  fpSub.textContent = enabled
    ? "Monitoring pages for fingerprint matches…"
    : "Turn on Real-Time Protection to monitor media fingerprints.";

  // Determine the active portal user from the current window's active tab and
  // look up their specific token — this isolates User A (regular window) from
  // User B (incognito window) even though they share the same extension.
  const portalUser = await getPortalUserFromActiveTab();
  const tokenMap = st.extensionTokenMap || {};
  // Primary: per-user map entry (works when active tab is the portal itself)
  let userEntry = portalUser?.userId ? tokenMap[portalUser.userId] : null;

  // Fallback: when the active tab is a non-portal page (YouTube, etc.) the
  // content script cannot read the portal JWT, so portalUser is null.
  // In that case, show the connection from the legacy single-token slot so
  // the user knows they are still linked regardless of which tab is active.
  if (!userEntry) {
    const legacy = await chrome.storage.local.get(["extensionToken", "linkedUser", "linkedDevice"]);
    if (legacy.extensionToken && legacy.linkedUser?.email) {
      userEntry = { token: legacy.extensionToken, user: legacy.linkedUser, device: legacy.linkedDevice };
    }
  }

  if (userEntry?.token && userEntry?.user?.email) {
    setConnectionVisual("connected", `Linked as ${userEntry.user.email}`);
    btnDisconnectPortal.disabled = false;
    btnAnalyzeNow.disabled = false;
    stopAnalysisPoll();
    if (st.lastAnalysisId) {
      const aStatus = st.lastAnalysisStatus;
      if (!aStatus || aStatus === "DONE") {
        // Status unknown (old session) or complete — show stored verdict
        updateResultUI(st.lastAnalysisVerdict, st.lastAnalysisScore, st.lastAnalysisMeta,
          st.lastAnalysisReason, st.lastAnalysisConfidence);
      } else if (aStatus === "ERROR") {
        analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
        analyzeMsg.textContent = "Previous analysis failed. Please analyze again.";
      } else {
        // PENDING or PROCESSING — start popup-side polling for live updates
        startAnalysisPoll(st.lastAnalysisId);
      }
    } else {
      analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
      analyzeMsg.textContent = "Run analysis to view verdict and reason.";
    }
    return;
  }

  // Use the specific user's linking state if available, otherwise global.
  const activeStatus = userEntry?.linkStatus || st.extensionLinkStatus;
  const activeError = userEntry?.linkError || st.extensionLinkError;

  if (activeStatus === "pending") {
    setConnectionVisual("pending", "Approve the request in the portal tab that just opened.");
    analyzeMsg.textContent = "Waiting for portal approval."; return;
  }
  if (activeStatus === "error") {
    setConnectionVisual("error", activeError || "Extension linking failed. Please try again.");
    analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = "Connection failed. Fix the portal link first, then try analyzing."; return;
  }

  setConnectionVisual("idle");
  analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Connect the extension to the portal first.";
}

const _NON_VERDICT_WORDS = new Set([
  "PENDING", "PROCESSING", "QUEUED", "DONE", "FAILED", "ERROR", "UNKNOWN", "PROCESSED",
]);

function getDisplayMetrics(backendVerdict, rawScore) {
  const v = (backendVerdict || "").toUpperCase();
  const riskScore = Math.round((rawScore ?? 0) * 100);
  // Treat status strings (not classification labels) as score-derived
  let classifiedVerdict = v;
  if (!v || _NON_VERDICT_WORDS.has(v)) {
    if (riskScore <= 29) classifiedVerdict = "REAL";
    else if (riskScore >= 70) classifiedVerdict = "FAKE";
    else classifiedVerdict = "INCONCLUSIVE";
  }
  const DISPLAY_LABELS = {
    FAKE: "DEEPFAKE DETECTED",
    REAL: "AUTHENTIC CONTENT",
    SUSPICIOUS: "SUSPICIOUS CONTENT",
    INCONCLUSIVE: "INCONCLUSIVE",
  };
  const verdictDisplay = DISPLAY_LABELS[classifiedVerdict] || classifiedVerdict;
  let tone = "amber";
  if (classifiedVerdict === "REAL") tone = "green";
  else if (classifiedVerdict === "FAKE" || classifiedVerdict === "SUSPICIOUS") tone = "red";
  if (classifiedVerdict === "SUSPICIOUS") tone = "amber";
  return { riskScore, displayVerdict: classifiedVerdict, verdictDisplay, tone };
}

function updateResultUI(verdictRaw, rawScore, meta, _reason, confidence) {
  analyzeMsg.style.display = "none"; analysisResultBlock.style.display = "block";
  const { riskScore, displayVerdict, verdictDisplay, tone } = getDisplayMetrics(verdictRaw, rawScore);

  resVerdictBadge.textContent = verdictDisplay;
  resVerdictBadge.className = `statusBadge ${tone === "green" ? "statusConnected" : tone === "red" ? "statusError" : "statusPending"}`;

  const confLabel = confidence ? ` · ${confidence.charAt(0).toUpperCase() + confidence.slice(1)} Conf.` : "";
  resRiskBadge.textContent = `${riskScore}% deepfake likelihood${confLabel}`;
  resRiskBadge.className = `riskText ${tone === "muted" ? "amber" : tone}`;

  // Media identity fields
  const platform = meta?.platform || "Unknown";
  const mediaType = (meta?.media_type || "video").charAt(0).toUpperCase() + (meta?.media_type || "video").slice(1);
  const sourceId = meta?.video_id || meta?.locked_video_id || meta?.current_video_id || "—";
  document.getElementById("idtMediaType").textContent = mediaType;
  document.getElementById("idtPlatform").textContent = platform.charAt(0).toUpperCase() + platform.slice(1);
  document.getElementById("idtTitle").textContent = meta?.title || "Unknown";
  document.getElementById("idtSource").textContent = sourceId;
  document.getElementById("idtSource").title = meta?.canonical_url || meta?.page_url || "";
  document.getElementById("idtVideoId").textContent = sourceId;

  // Show a concise one-line summary — full model breakdown is in the portal
  const REASON_SHORT = {
    FAKE:        "Multiple AI models detected strong manipulation in this media.",
    SUSPICIOUS:  "AI models detected manipulation indicators. Treat with caution.",
    REAL:        "No manipulation signals found. Content appears authentic.",
    INCONCLUSIVE:"Insufficient data for a confident verdict. Try re-analyzing.",
  };
  resReason.textContent = REASON_SHORT[displayVerdict] || "See portal for full analysis details.";

  if (displayVerdict === "FAKE") {
    resAction.textContent = "⚠ Do not share. Report as deepfake content.";
    resAction.className = "resAction red";
  } else if (displayVerdict === "SUSPICIOUS") {
    resAction.textContent = "⚠ Verify before sharing. Content shows suspicious signals.";
    resAction.className = "resAction amber";
  } else if (displayVerdict === "REAL") {
    resAction.textContent = "✓ Content verified as authentic. Safe to engage.";
    resAction.className = "resAction green";
  } else {
    resAction.textContent = "Re-analyze for a more definitive result.";
    resAction.className = "resAction amber";
  }
}

async function fetchLinkStatus(requestId) {
  const res = await fetch(`${API_BASE}/api/extension/link/request/${encodeURIComponent(requestId)}`);
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.detail || "Unable to load extension link status.");
  return json;
}

async function redeemLinkRequest(requestId, codeVerifier) {
  const res = await fetch(`${API_BASE}/api/extension/link/redeem`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, code_verifier: codeVerifier }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.detail || "Unable to redeem extension link.");

  // Save token into the per-user map so this user's connection is isolated from
  // other users who may be linked in separate browser windows / incognito.
  const userId = json.user?.id ? String(json.user.id) : null;
  const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
  const map = extensionTokenMap || {};
  if (userId) {
    map[userId] = {
      token: json.extension_token,
      user: json.user || null,
      device: json.device || null,
      linkStatus: "linked",
      linkError: ""
    };
  }

  await chrome.storage.local.set({
    extensionTokenMap: map,
    // Keep legacy slot
    extensionToken: json.extension_token, linkedUser: json.user || null,
    linkedDevice: json.device || null, extensionLinkStatus: "linked",
    extensionLinkError: "", extensionLinkRequestId: null, extensionCodeVerifier: null,
  });
  try { await chrome.runtime.sendMessage({ type: "EXTENSION_LINK_UPDATED" }); } catch { }
  return json;
}

async function resumeLinkPolling() {
  const st = await chrome.storage.local.get(["extensionLinkStatus", "extensionLinkRequestId", "extensionCodeVerifier", "extensionTokenMap"]);
  const portalUser = await getPortalUserFromActiveTab();
  const tokenMap = st.extensionTokenMap || {};
  const userEntry = portalUser?.userId ? tokenMap[portalUser.userId] : null;

  const activeRequestId = userEntry?.requestId || st.extensionLinkRequestId;
  const activeVerifier = userEntry?.codeVerifier || st.extensionCodeVerifier;
  const activeStatus = userEntry?.linkStatus || st.extensionLinkStatus;

  if (userEntry?.token) { stopLinkPolling(); await refreshUI(); return; }
  if (activeStatus !== "pending" || !activeRequestId || !activeVerifier) { stopLinkPolling(); return; }
  try {
    const status = await fetchLinkStatus(activeRequestId);
    if (status.status === "expired") {
       if (portalUser?.userId) {
         tokenMap[portalUser.userId] = { ...userEntry, linkStatus: "error", linkError: "Link request expired." };
         await chrome.storage.local.set({ extensionTokenMap: tokenMap });
       }
      await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: "Link request expired. Please start again." });
      stopLinkPolling(); await refreshUI(); return;
    }
    if (status.status === "approved") {
      if (isRedeeming) return; isRedeeming = true;
      try { await redeemLinkRequest(activeRequestId, activeVerifier); }
      finally { isRedeeming = false; }
      stopLinkPolling(); await refreshUI();
      analyzeMsg.textContent = "Extension linked! You can analyze this page now."; return;
    }
    if (status.status === "redeemed") {
      await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: "Link already used. Start a new connection.", extensionLinkRequestId: null, extensionCodeVerifier: null });
      stopLinkPolling(); await refreshUI(); return;
    }
    await refreshUI(); scheduleLinkPoll();
  } catch (err) {
    if (pollCount < 10) {
       scheduleLinkPoll(3000);
    } else {
       await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: "Lost connection to the portal. Please try again." });
       stopLinkPolling(); await refreshUI();
    }
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ monitoringEnabled: enabled });
  await sendToActiveTab({ type: "SET_MONITORING", enabled });
  await refreshUI();
});

btnAnalyzeNow.addEventListener("click", async () => {
  // Resolve the active portal user so the service worker uses the correct token.
  // Two-tier lookup: prefer per-user map, fall back to legacy slot (for non-portal tabs).
  const portalUser = await getPortalUserFromActiveTab();
  const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
  let userEntry = portalUser?.userId ? (extensionTokenMap || {})[portalUser.userId] : null;

  // Fallback for non-portal tabs (YouTube, Google, etc.) where getPortalUserFromActiveTab returns null
  if (!userEntry) {
    const legacy = await chrome.storage.local.get(["extensionToken", "linkedUser", "linkedDevice"]);
    if (legacy.extensionToken && legacy.linkedUser?.email) {
      userEntry = { token: legacy.extensionToken, user: legacy.linkedUser, device: legacy.linkedDevice };
    }
  }

  if (!userEntry?.token) {
    analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = "Connect the extension to the portal first.";
    await refreshUI(); return;
  }

  analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Capturing screen and sending to backend…";
  btnAnalyzeNow.disabled = true;

  // Pass userId so the service worker picks the right token from the map (or null to use legacy slot).
  const res = await chrome.runtime.sendMessage({
    type: "CAPTURE_SCREEN_AND_SEND",
    userId: portalUser?.userId || null,
  });

  btnAnalyzeNow.disabled = false;
  if (res?.ok) {
    stopAnalysisPoll();
    // Display result directly from response — no re-read from storage needed
    updateResultUI(res.verdict, res.score, res.analysis_meta, res.reason, res.confidence);
  } else {
    analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
    analyzeMsg.textContent = `Failed: ${res?.detail || res?.error || "capture/send failed"}`;
    if (String(res?.error || "").includes("401")) {
      await setDisconnectedState("Portal link expired. Connect the extension again.");
    }
    await refreshUI();
  }
});

btnConnectPortal.addEventListener("click", async () => {
  btnConnectPortal.disabled = true;
  try {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const codeVerifier = randomString(96);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const res = await fetch(`${API_BASE}/api/extension/link/request`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, code_challenge: codeChallenge, device_name: "Chrome Extension", extension_version: chrome.runtime.getManifest().version }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.detail || "Failed to create link request.");
    const portalUser = await getPortalUserFromActiveTab();
    const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
    const map = extensionTokenMap || {};
    if (portalUser?.userId) {
       map[portalUser.userId] = { ...map[portalUser.userId], linkStatus: "pending", requestId, codeVerifier };
       await chrome.storage.local.set({ extensionTokenMap: map });
    }
    await chrome.storage.local.set({
      extensionLinkStatus: "pending", extensionLinkRequestId: requestId,
      extensionCodeVerifier: codeVerifier, extensionLinkError: "",
    });
    await chrome.tabs.create({ url: `${CONNECT_URL}?request_id=${encodeURIComponent(requestId)}` });
    await refreshUI(); scheduleLinkPoll(1000);
  } catch (err) {
    const portalUser = await getPortalUserFromActiveTab();
    const { extensionTokenMap } = await chrome.storage.local.get(["extensionTokenMap"]);
    const map = extensionTokenMap || {};
    if (portalUser?.userId) {
       map[portalUser.userId] = { ...map[portalUser.userId], linkStatus: "error", linkError: err.message };
       await chrome.storage.local.set({ extensionTokenMap: map });
    }
    await chrome.storage.local.set({ extensionLinkStatus: "error", extensionLinkError: err.message || "Failed to connect." });
    await refreshUI();
  } finally { btnConnectPortal.disabled = false; }
});

btnDisconnectPortal.addEventListener("click", async () => {
  // Tell the service worker to revoke — pass userId so only that user's map
  // entry is cleared, leaving other users' connections intact.
  const portalUser = await getPortalUserFromActiveTab();
  try {
    await chrome.runtime.sendMessage({
      type: "DISCONNECT_EXTENSION",
      userId: portalUser?.userId || null,
    });
  } catch { }
  await setDisconnectedState("Extension disconnected. Connect again to resume.");
  analyzeMsg.style.display = "block"; analysisResultBlock.style.display = "none";
  analyzeMsg.textContent = "Extension disconnected.";
  await refreshUI();
});

openDashboard.addEventListener("click", async (e) => {
  e.preventDefault();
  const { lastAnalysisId } = await chrome.storage.local.get(["lastAnalysisId"]);
  await chrome.tabs.create({ url: lastAnalysisId ? `${MEDIA_ANALYSIS_URL}/${encodeURIComponent(lastAnalysisId)}` : DASHBOARD_URL });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "COUNTS_UPDATED" || msg?.type === "EXTENSION_LINK_UPDATED") refreshUI();
});

(async function init() {
  await refreshUI();
  const st = await chrome.storage.local.get(["extensionLinkStatus", "extensionLinkRequestId", "extensionCodeVerifier", "extensionTokenMap"]);
  // Only resume polling if there is still a pending link request and the active
  // portal user does not already have a token.
  const portalUser = await getPortalUserFromActiveTab();
  const map = st.extensionTokenMap || {};
  const alreadyLinked = portalUser?.userId && map[portalUser.userId]?.token;
  if (!alreadyLinked && st.extensionLinkStatus === "pending" && st.extensionLinkRequestId && st.extensionCodeVerifier) {
    scheduleLinkPoll(1000);
  }
})();
