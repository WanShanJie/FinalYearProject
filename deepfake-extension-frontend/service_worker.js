// service_worker.js
// Goal: analyze without interrupting playback.
// Strategy:
// 1) Use live DOM frame extraction first (no pause, no seek).
// 2) If DOM extraction is blank on protected players, use tabCapture through an offscreen document.
// 3) Never change currentTime or pause the player.

// Load IndexedDB helper — must be importScripts in a non-module service worker
try {
  importScripts("idb.js");
  console.log("[SW] idb.js loaded:", !!self.DeepfakeIDB, Object.keys(self.DeepfakeIDB || {}));
} catch (e) {
  console.error("[SW] idb.js load failed:", e);
}
const API_BASE = "http://127.0.0.1:8000";
const FRONTEND_BASE = "http://localhost:5173";
const PORTAL_ANALYSIS_URL = `${FRONTEND_BASE}/media-analysis`;

const FRAME_COUNT = 48;
const CAPTURE_INTERVAL_MS = 100;
const FALLBACK_CAPTURE_INTERVAL_MS = 300;
const JPEG_QUALITY = 80;
const READY_TIMEOUT_MS = 2500;
const BLANK_FALLBACK_THRESHOLD = 0.7;
const OFFSCREEN_URL = "offscreen.html";

let isCapturing = false;

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["monitoringEnabled", "scanned", "blocked"]);
  await chrome.storage.local.set({
    monitoringEnabled: st.monitoringEnabled ?? false,
    scanned: st.scanned ?? 0,
    blocked: st.blocked ?? 0,
    extensionLinkStatus: st.extensionLinkStatus ?? "idle",
    extensionLinkError: st.extensionLinkError ?? "",
  });
  // Sync blocklist on install/update
  syncBlocklist().catch(() => { });
  // Schedule periodic 30-min sync
  chrome.alarms.create("blocklist_sync", { periodInMinutes: 30 });
});

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
    if (shorts && shorts[1]) return shorts[1];
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }
  } catch { }
  return null;
}

function buildCanonicalYouTubeUrl(videoId, contextHint = "watch") {
  if (!videoId) return null;
  if (contextHint === "shorts") return `https://www.youtube.com/shorts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function ensureContentScript(tabId, retries = 1, delayMs = 100) {
  // 1. Try to ping existing script
  for (let i = 0; i < retries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (res?.ok) return true;
    } catch (e) { }
    if (i < retries - 1) await sleep(delayMs);
  }

  // 2. If no response, try manual injection
  try {
    console.log("[SW] Content script missing on tab", tabId, "- Injecting...");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["idb.js", "content.js"]
    }).catch(e => {
        if (String(e.message || e).includes("context_invalidated")) return;
        throw e;
    });

    await sleep(500); // Give time for script to initialize

    try {
      const res2 = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return !!res2?.ok;
    } catch (msgErr) {
      // If injection worked but ping failed (e.g. channel closed), assume it's there
      return true;
    }
  } catch (err) {
    console.warn("[SW] Failed to inject content script:", err);
    return false;
  }
}

async function getPageMeta(tabId, tab) {
  try {
    const reachable = await ensureContentScript(tabId);
    if (reachable) {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_META" });
          if (res?.ok && res?.meta) return res.meta;
          if (res?.page_url && res?.platform) return res;
        } catch { }
        await sleep(150);
      }
    }
  } catch (err) {
    console.warn("[SW] getPageMeta failed to reach content script, using tab fallback:", err);
  }

  return {
    platform: isYouTubeUrl(tab?.url || "") ? "youtube" : "unknown",
    page_url: tab?.url || "",
    video_id: parseYouTubeIdFromUrl(tab?.url || ""),
    current_video_id: null,
    canonical_url: null,
    player_context: null,
    title: tab?.title || "",
    video_ts: 0,
    captured_at: new Date().toISOString(),
    user_agent: null,
    viewport: null,
    media_type: "unknown",
    duration: null
  };
}

async function waitUntilReady(tabId, lockedVideoId) {
  // ensureContentScript was already called in getPageMeta — do not re-inject here.
  // Re-injecting races the first injection's initialisation and can create two
  // content-script instances with duplicate listeners.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PREP_CAPTURE", lockedVideoId });
  } catch { }

  // Single ready check — EXTRACT_FRAMES_LIVE has its own internal waitForVideoReady.
  try {
    const r = await chrome.tabs.sendMessage(tabId, {
      type: "WAIT_UNTIL_READY",
      timeoutMs: READY_TIMEOUT_MS,
      lockedVideoId
    });
    if (r?.ok && r?.ready) return true;
  } catch { }
  return false;
}

async function postToBackend(meta, blobs) {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) {
    throw new Error("Connect the extension to the portal first.");
  }

  const fd = new FormData();
  fd.append("meta", JSON.stringify(meta));

  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    fd.append("files", b, b.__filename || `frame_${String(i).padStart(3, "0")}.jpg`);
  }

  console.log("[SW] Posting to backend:", {
    url: `${API_BASE}/api/analysis/capture`,
    fileCount: blobs.length,
    meta
  });

  const res = await fetch(`${API_BASE}/api/analysis/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${extensionToken}`,
    },
    body: fd,
  });

  console.log("[SW] Backend response status:", res.status);

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("[SW] Backend upload failed:", txt);
    throw new Error(`HTTP ${res.status} ${txt}`.trim());
  }

  const json = await res.json();
  console.log("[SW] Backend response JSON:", json);
  return json;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture live tab frames for non-blocking deepfake analysis."
  });
}

async function captureViaOffscreenTab(tabId, rect = null, providedStreamId = null) {
  await ensureOffscreenDocument();

  let streamId = providedStreamId;
  if (!streamId) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      throw new Error(`tab_capture_stream_id_failed: ${e?.message || e}`);
    }
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_CAPTURE_TAB",
      streamId,
      frameCount: FRAME_COUNT,
      intervalMs: CAPTURE_INTERVAL_MS,
      quality: JPEG_QUALITY / 100,
      rect
    });
  } catch (e) {
    throw new Error(`offscreen_message_failed: ${e?.message || e}`);
  }

  if (!response?.ok) {
    throw new Error(response?.error || "offscreen_capture_failed");
  }

  const blobs = [];
  for (let i = 0; i < (response.frames || []).length; i++) {
    const blob = dataUrlToBlob(response.frames[i]);
    blob.__filename = `frame_${String(i).padStart(3, "0")}.jpg`;
    blobs.push(blob);
  }

  return {
    blobs,
    tsMs: response.tsMs || [],
    videoDimensions: response.videoDimensions || null,
    debug: response.debug || { source: "tab_capture_offscreen_locked", nonBlocking: true }
  };
}

async function clearExtensionLinkState({ keepCounts = true } = {}) {
  const current = keepCounts ? await chrome.storage.local.get(["scanned", "blocked", "monitoringEnabled"]) : {};
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    monitoringEnabled: current.monitoringEnabled ?? false,
    scanned: current.scanned ?? 0,
    blocked: current.blocked ?? 0,
    extensionLinkStatus: "idle",
    extensionLinkError: "",
  });
}

async function revokeLinkedExtensionSelf() {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) return;

  try {
    await fetch(`${API_BASE}/api/extension/devices/self/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${extensionToken}` },
    });
  } catch (err) {
    console.warn("[Extension] Failed to revoke linked device on backend:", err);
  }
}

async function handleCaptureSuccess(out, meta) {
  const st = await chrome.storage.local.get(["scanned", "blocked"]);
  const scanned = Number(st.scanned || 0) + 1;
  const blocked = Number(st.blocked || 0) + (["FAKE", "SUSPICIOUS"].includes(String(out?.verdict || "").toUpperCase()) ? 1 : 0);

  await chrome.storage.local.set({
    scanned,
    blocked,
    lastAnalysisId: out?.analysis_id ?? null,
    lastAnalysisVerdict: out?.verdict ?? null,
    lastAnalysisScore: out?.score ?? 0,
    lastAnalysisStatus: out?.status ?? null,
    lastAnalysisMeta: meta ?? null,
    lastPortalUrl: out?.analysis_id ? `${PORTAL_ANALYSIS_URL}?analysis_id=${encodeURIComponent(out.analysis_id)}` : PORTAL_ANALYSIS_URL,
    extensionLinkError: "",
  });

  try {
    await chrome.runtime.sendMessage({ type: "COUNTS_UPDATED" });
  } catch { }
  // Keep local blocklist in sync after every successful high-risk scan
  if (["FAKE", "SUSPICIOUS"].includes(String(out?.verdict || "").toUpperCase())) {
    setTimeout(() => {
      syncBlocklist().catch(() => { });
    }, 3000);
  }
}

// ─── Blocklist Sync ───────────────────────────────────────────────────────────
// idb.js is loaded via importScripts() at the top of this file.

async function syncBlocklist() {
  const { extensionToken } = await chrome.storage.local.get(["extensionToken"]);
  if (!extensionToken) {
    console.log("[Blocklist] Skipping sync — extension not linked.");
    return;
  }

  if (!self.DeepfakeIDB) {
    console.error("[Blocklist] DeepfakeIDB is not defined — idb.js failed to load.");
    return;
  }

  try {
    console.log("[Blocklist] Fetching active blocklist from backend...");
    const res = await fetch(`${API_BASE}/api/blocklist/sync`, {
      headers: { Authorization: `Bearer ${extensionToken}` },
    });
    if (!res.ok) {
      console.warn(`[Blocklist] Sync request failed: HTTP ${res.status}`);
      return;
    }
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.entries)) {
      console.warn("[Blocklist] Sync response malformed:", json);
      return;
    }

    const count = await self.DeepfakeIDB.idbBulkSync(json.entries);
    await chrome.storage.local.set({
      blocklistCount: json.entries.length,
      blocklistSyncedAt: Date.now(),
    });
    console.log(`[Blocklist] ✅ Synced ${count} entries into IndexedDB.`);
    if (json.entries.length > 0) {
      console.log("[Blocklist] Sample entry:", JSON.stringify(json.entries[0]));
    }

    // Notify open content scripts to re-check their pages
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "BLOCKLIST_UPDATED" }).catch(() => { });
    }
  } catch (err) {
    console.warn("[Blocklist] Sync exception:", err);
  }
}

// Periodic alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "blocklist_sync") {
    syncBlocklist().catch(() => { });
  }
  // "capture_keepalive" is intentionally a no-op: firing the alarm wakes the
  // service worker, preventing Chrome from killing it mid-capture.
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DISCONNECT_EXTENSION") {
    (async () => {
      await revokeLinkedExtensionSelf();
      await clearExtensionLinkState();
      try {
        await chrome.runtime.sendMessage({ type: "EXTENSION_LINK_UPDATED" });
      } catch { }
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "CHECK_VIDEO_ID_BLOCKLIST") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded in SW");
        const entry = await self.DeepfakeIDB.idbGetByVideoId(msg.videoId);
        console.log(`[SW] Blocklist check for videoId "${msg.videoId}":`, entry ? "MATCH" : "CLEAN");
        sendResponse({ ok: true, entry });
      } catch (err) {
        console.error("[SW] Video check error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === "CHECK_FINGERPRINT_BLOCKLIST") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded in SW");
        const entry = await self.DeepfakeIDB.idbGetEntry(msg.hash);
        console.log(`[SW] Blocklist check for hash "${msg.hash}":`, entry ? "MATCH" : "CLEAN");
        sendResponse({ ok: true, entry });
      } catch (err) {
        console.error("[SW] Hash check error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Layer B: bulk-return all active entries so content script can run pHash comparisons locally
  if (msg?.type === "GET_ALL_BLOCKLIST_ENTRIES") {
    (async () => {
      try {
        if (!self.DeepfakeIDB) throw new Error("IDB not loaded in SW");
        const entries = await self.DeepfakeIDB.idbGetAllActive();
        console.log(`[SW] GET_ALL_BLOCKLIST_ENTRIES: ${entries.length} active entries.`);
        sendResponse({ ok: true, entries });
      } catch (err) {
        console.error("[SW] GET_ALL_BLOCKLIST_ENTRIES error:", err);
        sendResponse({ ok: false, error: err.message });
      }
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

    let tabId = 0;

    try {
      tabId = Number(msg.targetTabId || 0);
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing targetTabId." });
        return;
      }

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.id) {
        sendResponse({ ok: false, error: "Target tab no longer exists." });
        return;
      }

      const tabUrlSnapshot = msg.targetTabUrl || tab.url || "";
      const providedStreamId = msg.streamId || null;

      // First suspension attempt: catches content scripts that are already running.
      await chrome.tabs.sendMessage(tabId, { type: "SUSPEND_SCANNING_FOR_CAPTURE" }).catch(() => { });

      // Keep the service worker alive for the full capture + upload sequence.
      // Chrome MV3 SWs can be killed during long async operations; a periodic
      // alarm prevents that without interfering with any other logic.
      chrome.alarms.create("capture_keepalive", { periodInMinutes: 0.4 }).catch(() => { });

      // getPageMeta may inject content.js if it isn't running yet. A freshly
      // injected script initialises with __captureInProgress = false, so we
      // must re-suspend immediately after getPageMeta returns.
      const meta0 = await getPageMeta(tabId, tab);
      await chrome.tabs.sendMessage(tabId, { type: "SUSPEND_SCANNING_FOR_CAPTURE" }).catch(() => { });
      const yt = meta0.platform === "youtube" || isYouTubeUrl(tabUrlSnapshot);

      if (!yt) {
        sendResponse({ ok: false, error: "This analyzer is optimized for YouTube and supported video platforms." });
        return;
      }

      const lockedVideoId =
        parseYouTubeIdFromUrl(tabUrlSnapshot) ||
        meta0.current_video_id ||
        meta0.video_id ||
        null;

      if (!lockedVideoId) {
        sendResponse({ ok: false, error: "Could not determine YouTube video_id." });
        return;
      }

      const contextHint = meta0.player_context || (tabUrlSnapshot.includes("/shorts/") ? "shorts" : "watch");
      const canonicalUrlRaw = meta0.canonical_url || buildCanonicalYouTubeUrl(lockedVideoId, contextHint);

      const ready = await waitUntilReady(tabId, lockedVideoId);

      // --- PRIMARY EXTRACTION: NATIVE DOM CANVAS (FAST) ---
      let nativeRes = await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_FRAMES_LIVE",
        frameCount: FRAME_COUNT,
        intervalMs: CAPTURE_INTERVAL_MS,
        quality: JPEG_QUALITY / 100,
        warmupMs: 300,
        lockedVideoId
      }).catch(() => null);

      let blobs = [];
      let tsMs = [];
      let captureMethod = "content_script_canvas_live_jpeg";
      let captureDebug = nativeRes?.debug || null;
      let videoDimensions = nativeRes ? { w: nativeRes.w || null, h: nativeRes.h || null } : null;

      const nativeBlankRatio = nativeRes?.debug?.totalRequested
        ? ((nativeRes.debug.blankCount || 0) / nativeRes.debug.totalRequested)
        : 1;

      const shouldFallback = !nativeRes?.ok || !Array.isArray(nativeRes.frames) || nativeRes.frames.length === 0 || nativeBlankRatio >= BLANK_FALLBACK_THRESHOLD;

      if (!shouldFallback) {
        for (let i = 0; i < nativeRes.frames.length; i++) {
          const blob = dataUrlToBlob(nativeRes.frames[i]);
          blob.__filename = `frame_${String(i).padStart(3, "0")}.jpg`;
          blobs.push(blob);
        }
        tsMs = nativeRes.tsMs || [];
      } else {
        // --- SECONDARY EXTRACTION: OFFSCREEN TAB CAPTURE (BACKGROUND STABLE) ---
        console.warn("[SW] Native capture failed/blank. Using offscreen fallback.", { nativeBlankRatio });

        let lockedRect = null;
        const offscreenRes = await captureViaOffscreenTab(tabId, lockedRect, providedStreamId);

        blobs = offscreenRes.blobs || [];
        tsMs = offscreenRes.tsMs || [];
        videoDimensions = offscreenRes.videoDimensions || videoDimensions;
        captureMethod = "tab_capture_offscreen_locked";
        captureDebug = {
          source: "tab_capture_offscreen_fallback",
          native_error: nativeRes?.error || "unknown",
          native_blank_ratio: nativeBlankRatio,
          offscreen_debug: offscreenRes?.debug || null
        };
      }

      const meta = {
        ...meta0,
        platform: "youtube",
        page_url: meta0.page_url || tabUrlSnapshot,
        canonical_url: canonicalUrlRaw,
        locked_video_id: lockedVideoId,
        video_id: lockedVideoId,
        captured_at: new Date().toISOString(),
        extension_version: chrome.runtime.getManifest().version,
        capture_mode: "multi_frame",
        capture_method: captureMethod,
        capture_debug: {
          ...captureDebug,
          native_debug: captureDebug?.native_debug ? { ...captureDebug.native_debug, perFrame: undefined } : undefined,
          perFrame: undefined
        },
        frame_count: blobs.length,
        frame_interval_ms: CAPTURE_INTERVAL_MS,
        frame_timestamps_ms: tsMs,
        video_dimensions: videoDimensions
      };

      try {
        const out = await postToBackend(meta, blobs);
        await handleCaptureSuccess(out, meta);
        sendResponse({ ok: true, ...out, capture_method: captureMethod, analysis_meta: meta });
      } catch (postErr) {
        console.error("[SW] Upload/Response failed:", postErr);
        sendResponse({ ok: false, error: String(postErr?.message || postErr) });
      }

    } catch (e) {
      console.error("[SW] CAPTURE_SCREEN_AND_SEND critical failure:", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    } finally {
      isCapturing = false;
      chrome.alarms.clear("capture_keepalive").catch(() => { });
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { type: "RESUME_SCANNING_AFTER_CAPTURE" }).catch(() => { });
      }
    }
  })();

  return true;
});
