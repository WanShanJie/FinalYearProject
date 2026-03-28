// service_worker.js

// Load IndexedDB helper synchronously (correct MV3 approach for non-module SW)
try {
  importScripts("idb.js");
} catch (e) {
  console.error("[SW] idb.js load failed:", e);
}

const API_BASE = "http://127.0.0.1:8000";
const FRONTEND_BASE = "http://localhost:5173";
const PORTAL_ANALYSIS_URL = `${FRONTEND_BASE}/media-analysis`;

const FRAME_COUNT = 48;
const CAPTURE_INTERVAL_MS = 200;
const JPEG_QUALITY = 80;
const READY_TIMEOUT_MS = 12000;
const BLANK_FALLBACK_THRESHOLD = 0.7;
const OFFSCREEN_URL = "offscreen.html";
const BLOCKLIST_SYNC_MIN_INTERVAL_MS = 10_000;

let isCapturing = false;

// ── Navigation blocking ───────────────────────────────────────────────────────
// In-memory Set of blocked video IDs for O(1) lookup without IDB round-trips.
// Rebuilt on SW startup and after every blocklist sync.
let blockedVideoIdSet = new Set();
let lastBlocklistSyncAt = 0;
let blocklistSyncPromise = null;

// Short-lived bypass Map: videoId → expiry timestamp (ms).
// Stored in-memory so the SW can check it synchronously with zero latency.
// Content scripts query it via the CHECK_BYPASS message.
const _bypassMap = new Map();

const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");

function _extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/shorts\/([^/?#]+)/);
      if (m?.[1]) return m[1];
    }
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
  } catch { }
  return null;
}

async function rebuildBlockedSet() {
  if (!self.DeepfakeIDB) return;
  try {
    const entries = await self.DeepfakeIDB.idbGetAllActive();
    blockedVideoIdSet = new Set(
      entries.filter(e => e.video_id).map(e => e.video_id)
    );
    console.log(`[BlockNav] Blocked set: ${blockedVideoIdSet.size} video IDs`);
  } catch (e) {
    console.warn("[BlockNav] rebuildBlockedSet failed:", e);
  }
}

async function maybeSyncBlocklist({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastBlocklistSyncAt < BLOCKLIST_SYNC_MIN_INTERVAL_MS) return;
  if (blocklistSyncPromise) return blocklistSyncPromise;

  blocklistSyncPromise = syncBlocklist()
    .catch(() => { })
    .finally(() => {
      blocklistSyncPromise = null;
    });

  return blocklistSyncPromise;
}

async function handleNavigation(details) {
  // Only intercept main-frame navigations.
  if (details.frameId !== 0) return;

  const url = details.url || "";

  // Skip the blocked page itself.
  if (url.startsWith(BLOCKED_PAGE)) return;

  const videoId = _extractVideoId(url);
  if (!videoId) return;
  await maybeSyncBlocklist();
  if (!blockedVideoIdSet.has(videoId)) return;

  // Check if the user explicitly chose to proceed for this video ID.
  const bypassExpiry = _bypassMap.get(videoId);
  if (bypassExpiry) {
    if (Date.now() < bypassExpiry) return;  // still within the bypass window
    _bypassMap.delete(videoId);
  }

  // Capture the tab's current URL as the "back" destination before redirecting.
  let referrerUrl = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    referrerUrl = tab?.url || "";
    // Don't use the blocked page itself or the video being blocked as a referrer.
    if (referrerUrl.startsWith(BLOCKED_PAGE) || _extractVideoId(referrerUrl) === videoId) {
      referrerUrl = "https://www.youtube.com/";
    }
  } catch { }

  // Fetch full entry so we can show title/verdict on the blocked page.
  let entry = null;
  try {
    if (self.DeepfakeIDB) entry = await self.DeepfakeIDB.idbGetByVideoId(videoId);
  } catch { }

  const params = new URLSearchParams({
    video_id: videoId,
    original_url: url,
    referrer_url: referrerUrl,
    title: entry?.title || "",
    verdict: entry?.verdict || "FAKE",
    risk_score: String(entry?.risk_score ?? 100),
  });

  try {
    await chrome.tabs.update(details.tabId, { url: `${BLOCKED_PAGE}?${params}` });
  } catch (e) {
    console.warn("[BlockNav] Redirect failed:", e);
  }
}

// Primary: fires before the renderer starts loading the page.
chrome.webNavigation.onBeforeNavigate.addListener(handleNavigation, {
  url: [{ hostContains: "youtube.com" }, { hostContains: "youtu.be" }],
});

// Secondary: catches YouTube SPA navigation (history.pushState / ?v= changes).
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation, {
  url: [{ hostContains: "youtube.com" }],
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["monitoringEnabled", "scanned", "blocked"]);
  await chrome.storage.local.set({
    monitoringEnabled: st.monitoringEnabled ?? false,
    scanned: st.scanned ?? 0,
    blocked: st.blocked ?? 0,
    extensionLinkStatus: st.extensionLinkStatus ?? "idle",
    extensionLinkError: st.extensionLinkError ?? "",
  });
  syncBlocklist().catch(() => { });
  chrome.alarms.create("blocklist_sync", { periodInMinutes: 30 });
});

// Re-populate the in-memory set whenever the SW wakes up after being killed.
chrome.runtime.onStartup.addListener(() => {
  rebuildBlockedSet().catch(() => { });
});
rebuildBlockedSet().catch(() => { });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime = (header.match(/data:(.*?);base64/) || [])[1] || "image/jpeg";
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function isYouTubeUrl(url = "") {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

function parseYouTubeIdFromUrl(url = "") {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return v;
    const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts?.[1]) return shorts[1];
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
  } catch { }
  return null;
}

function buildCanonicalYouTubeUrl(videoId, contextHint = "watch") {
  if (!videoId) return null;
  if (contextHint === "shorts") return `https://www.youtube.com/shorts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Simple injection: ping first, inject only if no response.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return; // Already installed.
  } catch { }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["idb.js", "content.js"],
    });
  } catch (e) {
    if (!String(e?.message || e).includes("context_invalidated")) {
      console.warn("[SW] Injection failed:", e);
    }
  }
  await sleep(400);
}

async function getPageMeta(tabId, tab) {
  await ensureContentScript(tabId);
  for (let i = 0; i < 10; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_META" });
      if (res?.ok && res?.meta) return res.meta;
      if (res?.page_url && res?.platform) return res;
    } catch { }
    await sleep(200);
  }
  return {
    platform: isYouTubeUrl(tab?.url || "") ? "youtube" : "unknown",
    page_url: tab?.url || "",
    video_id: parseYouTubeIdFromUrl(tab?.url || ""),
    current_video_id: null, canonical_url: null, player_context: null,
    title: tab?.title || "", video_ts: 0, captured_at: new Date().toISOString(),
    user_agent: null, viewport: null, media_type: "unknown", duration: null,
  };
}

async function waitUntilReady(tabId, lockedVideoId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PREP_CAPTURE", lockedVideoId });
  } catch { }
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, {
        type: "WAIT_UNTIL_READY", timeoutMs: READY_TIMEOUT_MS, lockedVideoId,
      });
      if (r?.ok && r?.ready) return true;
    } catch { }
    await sleep(250);
  }
  return false;
}

async function postToBackend(meta, blobs) {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) throw new Error("Connect the extension to the portal first.");
  const fd = new FormData();
  fd.append("meta", JSON.stringify(meta));
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    fd.append("files", b, b.__filename || `frame_${String(i).padStart(3, "0")}.jpg`);
  }
  console.log("[SW] Uploading", blobs.length, "frames to backend");
  const res = await fetch(`${API_BASE}/api/analysis/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${extensionToken}` },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`.trim());
  }
  return res.json();
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL, reasons: ["USER_MEDIA"],
    justification: "Capture live tab frames for deepfake analysis.",
  });
}

async function captureViaOffscreenTab(tabId) {
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CAPTURE_TAB", streamId,
    frameCount: FRAME_COUNT, intervalMs: CAPTURE_INTERVAL_MS, quality: JPEG_QUALITY / 100,
  });
  if (!response?.ok) throw new Error(response?.error || "offscreen_capture_failed");
  const blobs = [];
  for (let i = 0; i < (response.frames || []).length; i++) {
    const blob = dataUrlToBlob(response.frames[i]);
    blob.__filename = `frame_${String(i).padStart(3, "0")}.jpg`;
    blobs.push(blob);
  }
  return { blobs, tsMs: response.tsMs || [], videoDimensions: response.videoDimensions || null };
}

async function clearExtensionLinkState({ keepCounts = true } = {}) {
  const current = keepCounts ? await chrome.storage.local.get(["scanned", "blocked", "monitoringEnabled"]) : {};
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    monitoringEnabled: current.monitoringEnabled ?? false,
    scanned: current.scanned ?? 0, blocked: current.blocked ?? 0,
    extensionLinkStatus: "idle", extensionLinkError: "",
  });
}

async function revokeLinkedExtensionSelf() {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) return;
  try {
    await fetch(`${API_BASE}/api/extension/devices/self/revoke`, {
      method: "POST", headers: { Authorization: `Bearer ${extensionToken}` },
    });
  } catch { }
}

async function handleCaptureSuccess(out, meta) {
  const st = await chrome.storage.local.get(["scanned", "blocked"]);
  const scanned = Number(st.scanned || 0) + 1;
  const blocked = Number(st.blocked || 0) +
    (["FAKE", "SUSPICIOUS"].includes(String(out?.verdict || "").toUpperCase()) ? 1 : 0);
  await chrome.storage.local.set({
    scanned, blocked,
    lastAnalysisId: out?.analysis_id ?? null,
    lastAnalysisVerdict: out?.verdict ?? null,
    lastAnalysisScore: out?.score ?? 0,
    lastAnalysisStatus: out?.status ?? null,
    lastAnalysisMeta: meta ?? null,
    lastPortalUrl: out?.analysis_id
      ? `${PORTAL_ANALYSIS_URL}/${encodeURIComponent(out.analysis_id)}`
      : PORTAL_ANALYSIS_URL,
    extensionLinkError: "",
  });
  try { await chrome.runtime.sendMessage({ type: "COUNTS_UPDATED" }); } catch { }
  if (["FAKE", "SUSPICIOUS"].includes(String(out?.verdict || "").toUpperCase())) {
    setTimeout(() => syncBlocklist().catch(() => { }), 3000);
  }
}

// ── Blocklist sync ────────────────────────────────────────────────────────────

async function syncBlocklist() {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) return;
  if (!self.DeepfakeIDB) { console.error("[Blocklist] idb.js not loaded"); return; }
  try {
    const res = await fetch(`${API_BASE}/api/blocklist/sync`, {
      headers: { Authorization: `Bearer ${extensionToken}` },
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.entries)) return;
    await self.DeepfakeIDB.idbBulkSync(json.entries);
    lastBlocklistSyncAt = Date.now();
    await chrome.storage.local.set({ blocklistCount: json.entries.length, blocklistSyncedAt: Date.now() });
    console.log(`[Blocklist] Synced ${json.entries.length} entries.`);
    // Rebuild navigation block set immediately so new blocks take effect.
    await rebuildBlockedSet();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "BLOCKLIST_UPDATED" }).catch(() => { });
    }
  } catch (err) {
    console.warn("[Blocklist] Sync failed:", err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "blocklist_sync") syncBlocklist().catch(() => { });
  // capture_keepalive: no-op — just wakes the SW to prevent it being killed mid-capture.
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg?.type === "ALLOW_BYPASS") {
    // Synchronously write to the in-memory bypass map, then respond.
    // No async storage involved — the map is readable by handleNavigation
    // the instant this function returns.
    if (msg.videoId) _bypassMap.set(msg.videoId, Date.now() + 60_000);
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "CHECK_BYPASS") {
    // Content scripts ask the SW whether a video ID is currently bypassed.
    const expiry = _bypassMap.get(msg.videoId);
    const bypassed = !!expiry && Date.now() < expiry;
    if (expiry && !bypassed) _bypassMap.delete(msg.videoId);
    sendResponse({ bypassed });
    return true;
  }

  if (msg?.type === "DISCONNECT_EXTENSION") {
    (async () => {
      await revokeLinkedExtensionSelf();
      await clearExtensionLinkState();
      try { await chrome.runtime.sendMessage({ type: "EXTENSION_LINK_UPDATED" }); } catch { }
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "CHECK_VIDEO_ID_BLOCKLIST") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded");
        await maybeSyncBlocklist();
        const entry = await self.DeepfakeIDB.idbGetByVideoId(msg.videoId);
        sendResponse({ ok: true, entry: entry || null });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (msg?.type === "CHECK_FINGERPRINT_BLOCKLIST") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded");
        await maybeSyncBlocklist();
        const entry = await self.DeepfakeIDB.idbGetEntry(msg.hash);
        sendResponse({ ok: true, entry: entry || null });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (msg?.type === "GET_ALL_BLOCKLIST_ENTRIES") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded");
        const entries = await self.DeepfakeIDB.idbGetAllActive();
        sendResponse({ ok: true, entries });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (msg?.type !== "CAPTURE_SCREEN_AND_SEND") return;

  (async () => {
    if (isCapturing) {
      sendResponse({ ok: false, error: "Capture already running. Please wait." });
      return;
    }
    isCapturing = true;
    // Prevent SW from being killed during the capture + upload sequence.
    chrome.alarms.create("capture_keepalive", { periodInMinutes: 0.4 }).catch(() => { });

    try {
      const tab = await getActiveTab();
      if (!tab?.id) { sendResponse({ ok: false, error: "No active tab." }); return; }

      const tabId = tab.id;
      const tabUrlSnapshot = tab.url || "";
      const meta0 = await getPageMeta(tabId, tab);
      const yt = meta0.platform === "youtube" || isYouTubeUrl(tabUrlSnapshot);

      if (!yt) { sendResponse({ ok: false, error: "This analyzer is optimized for YouTube." }); return; }

      const lockedVideoId =
        parseYouTubeIdFromUrl(tabUrlSnapshot) || meta0.current_video_id || meta0.video_id || null;

      if (!lockedVideoId) { sendResponse({ ok: false, error: "Could not determine YouTube video_id." }); return; }

      const contextHint = meta0.player_context || (tabUrlSnapshot.includes("/shorts/") ? "shorts" : "watch");
      const canonicalUrlRaw = meta0.canonical_url || buildCanonicalYouTubeUrl(lockedVideoId, contextHint);

      const ready = await waitUntilReady(tabId, lockedVideoId);
      if (!ready) console.warn("[SW] Ready check timed out — attempting capture anyway.");

      const nativeRes = await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_FRAMES_LIVE",
        frameCount: FRAME_COUNT,
        intervalMs: CAPTURE_INTERVAL_MS,
        quality: JPEG_QUALITY / 100,
        warmupMs: 350,
        lockedVideoId,
      }).catch(() => null);

      let blobs = [], tsMs = [];
      const captureMethod = "content_script_canvas_live_jpeg";
      const captureDebug = nativeRes?.debug || null;
      const videoDimensions = nativeRes ? { w: nativeRes.w || null, h: nativeRes.h || null } : null;

      const nativeBlankRatio = nativeRes?.debug?.totalRequested
        ? ((nativeRes.debug.blankCount || 0) / nativeRes.debug.totalRequested) : 1;

      const shouldFallback = !nativeRes?.ok || !Array.isArray(nativeRes.frames) ||
        nativeRes.frames.length === 0 || nativeBlankRatio >= BLANK_FALLBACK_THRESHOLD;

      if (!shouldFallback) {
        for (let i = 0; i < nativeRes.frames.length; i++) {
          const blob = dataUrlToBlob(nativeRes.frames[i]);
          blob.__filename = `frame_${String(i).padStart(3, "0")}.jpg`;
          blobs.push(blob);
        }
        tsMs = nativeRes.tsMs || [];
      } else {
        sendResponse({
          ok: false, error: "live_capture_insufficient_frames",
          detail: `Got ${nativeRes?.frames?.length ?? 0} frames (blank ratio: ${nativeBlankRatio.toFixed(2)}).`,
          capture_debug: captureDebug,
        });
        return;
      }

      const meta = {
        ...meta0, platform: "youtube",
        page_url: meta0.page_url || tabUrlSnapshot,
        canonical_url: canonicalUrlRaw,
        locked_video_id: lockedVideoId, video_id: lockedVideoId,
        captured_at: new Date().toISOString(),
        extension_version: chrome.runtime.getManifest().version,
        capture_mode: "multi_frame", capture_method: captureMethod,
        capture_debug: captureDebug, frame_count: blobs.length,
        frame_interval_ms: CAPTURE_INTERVAL_MS, frame_timestamps_ms: tsMs,
        video_dimensions: videoDimensions,
      };

      const out = await postToBackend(meta, blobs);
      await handleCaptureSuccess(out, meta);
      sendResponse({ ok: true, ...out, capture_method: captureMethod, analysis_meta: meta });

    } catch (e) {
      console.error("[SW] Capture failed:", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    } finally {
      isCapturing = false;
      chrome.alarms.clear("capture_keepalive").catch(() => { });
    }
  })();

  return true;
});
