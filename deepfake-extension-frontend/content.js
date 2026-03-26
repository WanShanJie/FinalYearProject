// content.js
// Real-Time Protection: monitors IMG/VIDEO and checks IndexedDB blocklist.
// Analyze feature: provides GET_PAGE_META and EXTRACT_FRAMES_LIVE.

// ── SINGLE-INSTANCE GUARD ────────────────────────────────────────────────────
// Prevents duplicate listeners if the script is injected more than once.
// Uses a plain window property — never const/let at top level, which would
// throw "already declared" on re-injection in the same page context.
if (window.__deepfakeGuardInstalled) {
  // Already running. Bail out without registering anything.
  throw new Error("[DeepfakeGuard] Already installed — duplicate injection ignored.");
}
window.__deepfakeGuardInstalled = true;
// ─────────────────────────────────────────────────────────────────────────────

var monitoringEnabled = false;
var observerStarted = false;
var currentUrl = location.href;

// Set to true while EXTRACT_FRAMES_LIVE is running so scanning/blocking
// callbacks don't fire concurrently and interfere with frame capture.
window.__captureInProgress = false;

// ── Safe SW messaging ─────────────────────────────────────────────────────────

var _contextDead = false;
function safeSendMessage(msg) {
  return new Promise(resolve => {
    if (_contextDead) return resolve({ ok: false, error: "context dead" });
    try {
      chrome.runtime.sendMessage(msg, response => {
        const err = chrome.runtime.lastError;
        if (err) {
          if ((err.message || "").includes("Extension context invalidated")) _contextDead = true;
          return resolve({ ok: false, error: err.message });
        }
        resolve(response || { ok: true });
      });
    } catch (e) {
      if ((e.message || "").includes("Extension context invalidated")) _contextDead = true;
      resolve({ ok: false, error: e.message });
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bumpCounter(key, inc = 1) {
  const st = await chrome.storage.local.get([key]);
  await chrome.storage.local.set({ [key]: (st[key] ?? 0) + inc });
}

async function loadMonitoringFlag() {
  const st = await chrome.storage.local.get(["monitoringEnabled"]);
  monitoringEnabled = st.monitoringEnabled === true;
  if (!window.__captureInProgress) checkVideoIdOnPage().catch(() => { });
}

function startObserver() {
  if (observerStarted) return;
  observerStarted = true;
  mo.observe(document.documentElement, { childList: true, subtree: true });
  scanExisting();
}

function stopObserver() {
  if (!observerStarted) return;
  observerStarted = false;
  mo.disconnect();
}

function isMediaEl(el) { return el && (el.tagName === "IMG" || el.tagName === "VIDEO"); }

// ── Blocking overlay ──────────────────────────────────────────────────────────

function blockElement(el, entry) {
  if (window.__captureInProgress) return;
  if (el.dataset.deepfakeBlocked === "1") return;
  el.dataset.deepfakeBlocked = "1";

  const parent = el.parentElement;
  if (!parent) return;
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;display:inline-block;width:100%;";
  parent.insertBefore(wrapper, el);
  wrapper.appendChild(el);

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:absolute", "inset:0", "background:rgba(15,15,20,0.92)",
    "display:flex", "flex-direction:column", "align-items:center",
    "justify-content:center", "gap:8px", "z-index:9999",
    "border-radius:8px", "pointer-events:auto", "cursor:default",
  ].join(";");

  const icon = document.createElement("div");
  icon.textContent = "🚫"; icon.style.cssText = "font-size:2rem;";

  const title = document.createElement("div");
  title.textContent = "Blocked: Suspected Deepfake";
  title.style.cssText = "color:#ef4444;font-weight:700;font-size:1rem;text-align:center;";

  const sub = document.createElement("div");
  sub.textContent = entry?.risk_score != null
    ? `Risk: ${entry.risk_score}%` : "Blocked by Real-Time Protection";
  sub.style.cssText = "color:#aaa;font-size:0.8rem;text-align:center;max-width:260px;";

  overlay.append(icon, title, sub);
  wrapper.appendChild(overlay);
}

// ── Fingerprint (aHash) ───────────────────────────────────────────────────────

function drawToCanvas(el, size = 32) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(el, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

function aHash(imageData) {
  const { data } = imageData;
  const gray = [];
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray.push(g); sum += g;
  }
  const avg = sum / gray.length;
  let bits = "";
  for (const g of gray) bits += g >= avg ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

async function fingerprintElement(el) {
  if (el.tagName === "IMG") {
    if (!el.complete || el.naturalWidth === 0) return null;
    return aHash(drawToCanvas(el));
  }
  if (el.tagName === "VIDEO") {
    if (el.readyState < 2) return null;
    return aHash(drawToCanvas(el));
  }
  return null;
}

async function processMedia(el) {
  if (window.__captureInProgress || !monitoringEnabled) return;
  try {
    const hash = await fingerprintElement(el);
    if (!hash) return;
    await bumpCounter("scanned", 1);
    const res = await safeSendMessage({ type: "CHECK_FINGERPRINT_BLOCKLIST", hash });
    if (res?.ok && res?.entry) {
      blockElement(el, res.entry);
      await bumpCounter("blocked", 1);
    }
    safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
  } catch { }
}

// ── Video ID page check ───────────────────────────────────────────────────────

var _videoIdCache = new Map();

async function checkVideoIdOnPage() {
  if (window.__captureInProgress) return;
  try {
    const url = location.href;
    let videoId = null;
    const shorts = url.match(/\/shorts\/([^/?]+)/);
    if (shorts) videoId = shorts[1];
    else { try { videoId = new URL(url).searchParams.get("v"); } catch { } }
    if (!videoId) return;

    if (_videoIdCache.has(videoId)) {
      const cached = _videoIdCache.get(videoId);
      if (cached) document.querySelectorAll("video").forEach(v => blockElement(v, cached));
      return;
    }

    const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
    _videoIdCache.set(videoId, res?.ok && res?.entry ? res.entry : null);
    if (res?.ok && res?.entry) {
      document.querySelectorAll("video").forEach(v => blockElement(v, res.entry));
      await bumpCounter("blocked", 1);
      safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
    }
  } catch { }
}

// ── YouTube card scanning (Layer A: exact video_id only) ──────────────────────

var YT_CARD_SELECTORS = [
  "ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
  "ytd-compact-video-renderer", "ytd-reel-item-renderer",
].join(", ");

var _scannedCards = new WeakSet();

function extractCardVideoId(card) {
  for (const a of card.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    const s = href.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/);
    if (s) return s[1];
    try {
      const u = new URL(href, "https://www.youtube.com");
      if (u.pathname === "/watch") { const v = u.searchParams.get("v"); if (v) return v; }
    } catch { }
  }
  return null;
}

async function processYouTubeCard(card) {
  if (window.__captureInProgress) return;
  if (_scannedCards.has(card)) return;
  _scannedCards.add(card);

  const videoId = extractCardVideoId(card);
  if (!videoId) return;

  if (_videoIdCache.has(videoId)) {
    const entry = _videoIdCache.get(videoId);
    if (entry) {
      if (getComputedStyle(card).position === "static") card.style.position = "relative";
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:absolute;inset:0;background:rgba(15,15,20,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;border-radius:6px;";
      overlay.innerHTML = '<span style="color:#ef4444;font-weight:700;font-size:0.85rem;">🚫 Blocked</span>';
      card.appendChild(overlay);
    }
    return;
  }

  const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
  const entry = res?.ok && res?.entry ? res.entry : null;
  _videoIdCache.set(videoId, entry);

  if (entry) {
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;background:rgba(15,15,20,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;border-radius:6px;";
    overlay.innerHTML = '<span style="color:#ef4444;font-weight:700;font-size:0.85rem;">🚫 Blocked</span>';
    card.appendChild(overlay);
    bumpCounter("blocked", 1).catch(() => { });
    safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
  }
}

function scanYouTubeCards(root = document) {
  if (window.__captureInProgress) return;
  if (!location.hostname.includes("youtube.com")) return;
  try {
    root.querySelectorAll(YT_CARD_SELECTORS).forEach(card => {
      if (!_scannedCards.has(card)) processYouTubeCard(card).catch(() => { });
    });
  } catch { }
}

function scanExisting() {
  if (window.__captureInProgress) return;
  if (monitoringEnabled) {
    document.querySelectorAll("img,video").forEach(el => processMedia(el).catch(() => { }));
  }
  scanYouTubeCards(document);
  checkVideoIdOnPage().catch(() => { });
}

var scanTimer = null;
var mo = new MutationObserver((mutations) => {
  if (window.__captureInProgress) return;
  let hasRelevant = false;
  for (const m of mutations) {
    if (m.addedNodes.length > 0) { hasRelevant = true; break; }
  }
  if (!hasRelevant) return;

  // SPA navigation detection
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    _videoIdCache.clear();
    _scannedCards = new WeakSet();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { checkVideoIdOnPage().catch(() => { }); scanYouTubeCards(document); }, 300);
    return;
  }

  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanYouTubeCards(document), 300);
});

// ── Video capture helpers ─────────────────────────────────────────────────────

function getPlatform() {
  const h = location.hostname;
  if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
  if (h.includes("tiktok.com")) return "tiktok";
  if (h.includes("facebook.com") || h.includes("fb.watch")) return "facebook";
  return "other";
}

function getYouTubeTitle() {
  return document.querySelector("h1.ytd-watch-metadata")?.innerText?.trim()
    || document.querySelector('meta[name="title"]')?.getAttribute("content")?.trim()
    || document.title || "";
}

function getVideoTimestamp() {
  const vids = Array.from(document.querySelectorAll("video")).sort(
    (a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  const v = vids.find(x => x.readyState >= 2) || vids[0];
  return v ? Number(v.currentTime || 0) : 0;
}

function getYouTubeTimestamp() {
  const main = document.querySelector("video.html5-main-video");
  return (main && Number.isFinite(main.currentTime)) ? Number(main.currentTime) : getVideoTimestamp();
}

function getYouTubeCurrentVideoIdAndContext() {
  const shorts = location.pathname.match(/\/shorts\/([^/?]+)/);
  if (shorts?.[1]) return { videoId: shorts[1], context: "shorts" };
  const v = new URL(location.href).searchParams.get("v");
  if (v) return { videoId: v, context: "watch" };
  const flexy = document.querySelector("ytd-watch-flexy[video-id]");
  if (flexy?.getAttribute("video-id")) return { videoId: flexy.getAttribute("video-id"), context: "watch" };
  return { videoId: null, context: null };
}

function buildYouTubeCanonicalUrl(videoId, context) {
  if (!videoId) return null;
  return context === "shorts"
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

function getMainVideoEl() {
  const vids = Array.from(document.querySelectorAll("video"))
    .filter(v => v.offsetParent !== null)
    .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  return vids[0]
    || document.querySelector("video.html5-main-video")
    || document.querySelector("video");
}

function findVideoElementForCapture(lockedVideoId) {
  if (location.pathname.includes("/shorts/")) {
    return document.querySelector("ytd-reel-video-renderer[is-active] video")
      || document.querySelector("ytd-reel-video-renderer video")
      || getMainVideoEl();
  }
  return getMainVideoEl();
}

function getTikTokVideoId() {
  const m = location.href.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function getFacebookVideoId() {
  const v = new URL(location.href).searchParams.get("v");
  if (v) return v;
  const m = location.href.match(/fb\.watch\/([^/?]+)/);
  return m ? m[1] : null;
}

function pickBestVisibleMediaEl() {
  const vids = Array.from(document.querySelectorAll("video"))
    .filter(v => v.offsetParent !== null)
    .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  if (vids[0]) return vids[0];
  const imgs = Array.from(document.querySelectorAll("img"))
    .filter(i => i.offsetParent !== null && i.naturalWidth > 150);
  imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
  return imgs[0] || null;
}

async function waitForPresentedVideoFrame(video, timeoutMs = 1200) {
  if (!video) return false;
  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise(resolve => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
      video.requestVideoFrameCallback(() => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
    });
  }
  await wait(Math.min(180, timeoutMs));
  return true;
}

async function waitForVideoReady(timeoutMs = 12000, lockedVideoId = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = findVideoElementForCapture(lockedVideoId) || getMainVideoEl();
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      await waitForPresentedVideoFrame(v, 800);
      if (v.videoWidth > 0 && v.readyState >= 2) {
        return { ok: true, ready: true, video: v, w: v.videoWidth, h: v.videoHeight, ts: Number(v.currentTime || 0) };
      }
    }
    await wait(150);
  }
  return { ok: false, ready: false, error: "timeout_waiting_video_ready" };
}

function frameStatsFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return { avgLuma: 0, nonBlackRatio: 0, isMostlyBlack: true };
  const sw = Math.min(64, canvas.width), sh = Math.min(64, canvas.height);
  const sx = Math.floor((canvas.width - sw) / 2), sy = Math.floor((canvas.height - sh) / 2);
  const { data, width, height } = ctx.getImageData(sx, sy, sw, sh);
  let total = 0, nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    total += luma;
    if (luma > 10) nonBlack++;
  }
  const px = width * height;
  const avgLuma = px ? total / px : 0;
  const nonBlackRatio = px ? nonBlack / px : 0;
  return { avgLuma, nonBlackRatio, isMostlyBlack: avgLuma < 8 || nonBlackRatio < 0.02 };
}

async function waitUntilNotMostlyBlack(video, canvas, ctx, timeoutMs = 2500, quality = 0.8) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (video.videoWidth > 0 &&
      (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); }
    catch { await wait(120); continue; }
    const stats = frameStatsFromCanvas(canvas);
    if (!stats.isMostlyBlack) {
      return { ok: true, stats, dataUrl: canvas.toDataURL("image/jpeg", quality) };
    }
    await waitForPresentedVideoFrame(video, 600);
  }
  return { ok: false, stats: null };
}

async function extractLiveFramesFromVideo(video, {
  frameCount = 48, intervalMs = 100, quality = 0.8, warmupMs = 350, lockedVideoId = null,
} = {}) {
  if (!video) return { ok: false, error: "no_video_element" };

  const ready = await waitForVideoReady(12000, lockedVideoId);
  if (!ready.ok) return { ok: false, error: ready.error || "not_ready" };
  video = ready.video || video;

  if (video.videoWidth === 0 || video.videoHeight === 0) return { ok: false, error: "invalid_video" };

  console.log("[Capture] video ready:", { w: video.videoWidth, h: video.videoHeight, frameCount, intervalMs });

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const startedAt = Date.now();
  const frames = [], tsMs = [], perFrame = [];
  let blankCount = 0;

  await wait(Math.max(0, warmupMs));
  await waitForPresentedVideoFrame(video, 1200);

  for (let i = 0; i < frameCount; i++) {
    const capture = await waitUntilNotMostlyBlack(video, canvas, ctx, 2200, quality);
    const currentTsMs = Math.round(Number(video.currentTime || 0) * 1000);

    if (capture.ok) {
      frames.push(capture.dataUrl);
      tsMs.push(currentTsMs);
      perFrame.push({ idx: i, tsMs: currentTsMs, ok: true });
      console.log(`[Capture] frame ${i} at ${currentTsMs}ms`);
    } else {
      blankCount++;
      perFrame.push({ idx: i, tsMs: currentTsMs, ok: false, reason: "blank" });
      console.warn(`[Capture] frame ${i} blank`);
    }

    if (i < frameCount - 1) await wait(intervalMs);
  }

  console.log("[Capture] extraction done:", { requested: frameCount, captured: frames.length, blankCount, elapsedMs: Date.now() - startedAt });

  return {
    ok: frames.length > 0, frames, tsMs,
    w: canvas.width, h: canvas.height,
    debug: { totalRequested: frameCount, capturedCount: frames.length, blankCount, elapsedMs: Date.now() - startedAt, perFrame },
    error: frames.length > 0 ? null : "all_frames_blank",
  };
}

// ── Page meta helpers ─────────────────────────────────────────────────────────

function findFacebookPostUrl() {
  const vids = Array.from(document.querySelectorAll("video")).filter(v => v.offsetParent !== null);
  const root = vids[0]?.closest('div[role="article"]') || vids[0]?.parentElement;
  if (!root) return { post_url: null, post_id: null };
  const links = Array.from(root.querySelectorAll("a[href]"))
    .map(a => { try { return new URL(a.getAttribute("href"), location.origin).toString(); } catch { return null; } })
    .filter(Boolean);
  const post_url = links.find(u => u.includes("/reel/") || u.includes("/videos/") || u.includes("/watch/?v=")) || null;
  const m = post_url?.match(/\/(?:reel|videos)\/(\d+)/) || post_url?.match(/[?&]v=(\d+)/);
  return { post_url, post_id: m ? m[1] : null };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "PING") {
      sendResponse({ ok: true, ready: true, url: location.href });
      return;
    }

    if (msg?.type === "WAIT_UNTIL_READY") {
      const res = await waitForVideoReady(Number(msg.timeoutMs || 12000), msg.lockedVideoId || null);
      sendResponse(res);
      return;
    }

    if (msg?.type === "PREP_CAPTURE") {
      const res = await waitForVideoReady(3000, msg.lockedVideoId || null);
      sendResponse(res.ok ? { ok: true, ...res } : res);
      return;
    }

    if (msg?.type === "EXTRACT_FRAMES_LIVE") {
      window.__captureInProgress = true;
      stopObserver();
      console.log("[Capture] START");

      try {
        const v = findVideoElementForCapture(msg.lockedVideoId);
        if (!v) { sendResponse({ ok: false, error: "no_video_element" }); return; }

        const out = await extractLiveFramesFromVideo(v, {
          frameCount: Number(msg.frameCount || 48),
          intervalMs: Number(msg.intervalMs || 100),
          quality: Number(msg.quality || 0.8),
          warmupMs: Number(msg.warmupMs || 350),
          lockedVideoId: msg.lockedVideoId || null,
        });

        sendResponse(out);
      } catch (err) {
        console.error("[Capture] EXTRACT_FRAMES_LIVE error:", err);
        sendResponse({ ok: false, error: err?.message || "extract_failed" });
      } finally {
        window.__captureInProgress = false;
        startObserver();
        console.log("[Capture] END");
      }
      return;
    }

    if (msg?.type === "SET_MONITORING") {
      monitoringEnabled = !!msg.enabled;
      await chrome.storage.local.set({ monitoringEnabled });
      if (monitoringEnabled) startObserver(); else stopObserver();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "GET_PAGE_META") {
      const platform = getPlatform();
      const media = pickBestVisibleMediaEl();
      let title = "", video_id = null, current_video_id = null;
      let canonical_url = null, player_context = null, video_ts = 0, duration = null;
      const media_type = media?.tagName === "VIDEO" ? "video" : (media?.tagName === "IMG" ? "image" : "unknown");

      if (platform === "youtube") {
        title = getYouTubeTitle();
        const yt = getYouTubeCurrentVideoIdAndContext();
        current_video_id = video_id = yt.videoId;
        player_context = yt.context;
        canonical_url = buildYouTubeCanonicalUrl(yt.videoId, yt.context);
        video_ts = getYouTubeTimestamp();
        duration = Number(getMainVideoEl()?.duration || 0) || null;
      } else if (platform === "tiktok") {
        current_video_id = video_id = getTikTokVideoId();
        canonical_url = location.href;
        video_ts = getVideoTimestamp();
        duration = Number(document.querySelector("video")?.duration || 0) || null;
      } else if (platform === "facebook") {
        const fb = findFacebookPostUrl();
        current_video_id = video_id = fb.post_id || getFacebookVideoId();
        canonical_url = fb.post_url || location.href;
        video_ts = getVideoTimestamp();
        duration = Number(document.querySelector("video")?.duration || 0) || null;
      } else {
        canonical_url = location.href;
        video_ts = getVideoTimestamp();
        duration = Number(document.querySelector("video")?.duration || 0) || null;
      }

      sendResponse({
        ok: true,
        meta: {
          title, platform, page_url: location.href, canonical_url,
          video_id, current_video_id, player_context, video_ts, duration,
          media_type, captured_at: new Date().toISOString(),
          user_agent: navigator.userAgent,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        },
      });
      return;
    }

    if (msg?.type === "GET_CURRENT_TS") {
      sendResponse({ ok: true, video_ts: getPlatform() === "youtube" ? getYouTubeTimestamp() : getVideoTimestamp() });
      return;
    }

    if (msg?.type === "BLOCKLIST_UPDATED") {
      _videoIdCache.clear();
      _scannedCards = new WeakSet();
      if (!window.__captureInProgress) {
        checkVideoIdOnPage().catch(() => { });
        scanExisting();
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_message_type" });
  })();

  return true;
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  await loadMonitoringFlag();
  startObserver();
  setTimeout(() => { if (!window.__captureInProgress) scanExisting(); }, 1000);
  setTimeout(() => { if (!window.__captureInProgress) checkVideoIdOnPage().catch(() => { }); }, 2500);
})();