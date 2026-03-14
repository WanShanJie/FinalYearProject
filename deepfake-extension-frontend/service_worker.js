// service_worker.js
// Goal: analyze without interrupting playback.
// Strategy:
// 1) Use live DOM frame extraction first (no pause, no seek).
// 2) If DOM extraction is blank on protected players, use tabCapture through an offscreen document.
// 3) Never change currentTime or pause the player.

const API_BASE = "http://127.0.0.1:8000";

const FRAME_COUNT = 48;
const CAPTURE_INTERVAL_MS = 100;
const JPEG_QUALITY = 80;
const READY_TIMEOUT_MS = 12000;
const BLANK_FALLBACK_THRESHOLD = 0.7;
const OFFSCREEN_URL = "offscreen.html";

let isCapturing = false;

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["monitoringEnabled", "scanned", "blocked"]);
  await chrome.storage.local.set({
    monitoringEnabled: st.monitoringEnabled ?? false,
    scanned: st.scanned ?? 0,
    blocked: st.blocked ?? 0
  });
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

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch { }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["idb.js", "content.js"]
  });
  await sleep(350);
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
  await ensureContentScript(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PREP_CAPTURE",
      lockedVideoId
    });
  } catch { }

  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, {
        type: "WAIT_UNTIL_READY",
        timeoutMs: READY_TIMEOUT_MS,
        lockedVideoId
      });
      if (r?.ok && r?.ready) return true;
    } catch { }
    await sleep(250);
  }
  return false;
}

async function postToBackend(meta, blobs) {
  const fd = new FormData();
  fd.append("meta", JSON.stringify(meta));
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    fd.append("files", b, b.__filename || `frame_${String(i).padStart(3, "0")}.jpg`);
  }

  const res = await fetch(`${API_BASE}/api/analysis/capture`, { method: "POST", body: fd });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`.trim());
  }
  return await res.json().catch(() => ({ ok: true }));
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

async function captureViaOffscreenTab(tabId, lockedRect) {
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CAPTURE_TAB",
    streamId,
    frameCount: FRAME_COUNT,
    intervalMs: CAPTURE_INTERVAL_MS,
    quality: JPEG_QUALITY / 100,
    lockedRect
  });

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
    debug: response.debug || { source: "tab_capture_offscreen", nonBlocking: true }
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "CAPTURE_SCREEN_AND_SEND") return;

  (async () => {
    if (isCapturing) {
      sendResponse({ ok: false, error: "Capture already running. Please wait." });
      return;
    }
    isCapturing = true;

    try {
      const tab = await getActiveTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }

      const tabId = tab.id;
      const tabUrlSnapshot = tab.url || "";
      const meta0 = await getPageMeta(tabId, tab);
      const yt = meta0.platform === "youtube" || isYouTubeUrl(tabUrlSnapshot);

      if (!yt) {
        sendResponse({ ok: false, error: "This non-blocking analyzer is currently optimized for video pages." });
        return;
      }

      const lockedVideoId =
        parseYouTubeIdFromUrl(tabUrlSnapshot) ||
        meta0.current_video_id ||
        meta0.video_id ||
        null;

      if (!lockedVideoId) {
        sendResponse({ ok: false, error: "Could not determine YouTube video_id to lock." });
        return;
      }

      const contextHint = meta0.player_context || (tabUrlSnapshot.includes("/shorts/") ? "shorts" : "watch");
      const canonicalUrlRaw = meta0.canonical_url || buildCanonicalYouTubeUrl(lockedVideoId, contextHint);

      const ready = await waitUntilReady(tabId, lockedVideoId);
      if (!ready) {
        console.warn("[Capture] Preflight ready check failed; trying live extraction anyway.", {
          lockedVideoId,
          url: tabUrlSnapshot
        });
      }

      const nativeRes = await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_FRAMES_LIVE",
        frameCount: FRAME_COUNT,
        intervalMs: CAPTURE_INTERVAL_MS,
        quality: JPEG_QUALITY / 100,
        warmupMs: 350,
        lockedVideoId,          // content.js uses this to lock onto the right reel element
      }).catch(() => null);

      let blobs = [];
      let tsMs = [];
      let captureMethod = "content_script_canvas_live_jpeg";
      let captureDebug = nativeRes?.debug || null;
      let videoDimensions = nativeRes ? { w: nativeRes.w || null, h: nativeRes.h || null } : null;

      const nativeBlankRatio = nativeRes?.debug?.totalRequested
        ? ((nativeRes.debug.blankCount || 0) / nativeRes.debug.totalRequested)
        : 1;

      const shouldFallback =
        !nativeRes?.ok ||
        !Array.isArray(nativeRes.frames) ||
        nativeRes.frames.length === 0 ||
        nativeBlankRatio >= BLANK_FALLBACK_THRESHOLD;

      if (!shouldFallback) {
        for (let i = 0; i < nativeRes.frames.length; i++) {
          const blob = dataUrlToBlob(nativeRes.frames[i]);
          blob.__filename = `frame_${String(i).padStart(3, "0")}.jpg`;
          blobs.push(blob);
        }
        tsMs = nativeRes.tsMs || [];
      } else {
        // YouTube: NEVER fall back to tabCapture.
        // tabCapture hijacks the tab's audio pipeline at the OS level.
        // Even with loopback, stopping the stream disconnects YouTube's Web Audio
        // graph permanently — the user must reload the page to get sound back.
        // The native canvas path already works and never touches audio.
        sendResponse({
          ok: false,
          error: "live_capture_insufficient_frames",
          detail: contextHint === "shorts"
            ? "Shorts target was found, but not enough usable frames were produced. Try again after the reel has visibly started rendering."
            : `Native capture got ${nativeRes?.frames?.length ?? 0} usable frames (blank ratio: ${nativeBlankRatio.toFixed(2)}).`,
          capture_debug: nativeRes?.debug || null,
        });
        return;
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
        capture_debug: captureDebug,
        frame_count: blobs.length,
        frame_interval_ms: CAPTURE_INTERVAL_MS,
        frame_timestamps_ms: tsMs,
        video_dimensions: videoDimensions
      };

      const out = await postToBackend(meta, blobs);
      sendResponse({ ok: true, ...out, capture_method: captureMethod });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    } finally {
      isCapturing = false;
    }
  })();

  return true;
});
