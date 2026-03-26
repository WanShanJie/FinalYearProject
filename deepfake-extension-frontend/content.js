// content.js
// Real-Time Protection: monitors IMG/VIDEO and checks local IndexedDB blocklist using a demo aHash.
// Analyze feature: provides GET_PAGE_META metadata and supports PREP_CAPTURE / WAIT_UNTIL_READY / SEEK_TO.

var monitoringEnabled = false;
var observerStarted = false;
var currentUrl = location.href;
window._blockedEntry = null;
window.__captureInProgress = false;

// NEW FUNCTION: Safe Messaging Wrapper
var _extensionContextDead = false;
async function safeSendMessage(msg) {
  return new Promise(resolve => {
    if (_extensionContextDead) return resolve({ ok: false, error: "Extension context invalidated" });
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return resolve({ ok: false, error: "No chrome.runtime" });
      }
      chrome.runtime.sendMessage(msg, response => {
        const err = chrome.runtime.lastError;
        if (err) {
          const errMsg = err.message || "";
          if (errMsg.includes("Extension context invalidated")) {
            _extensionContextDead = true;
            console.warn("[BlocklistGuard] Extension context invalidated! Halting messaging.");
          }
          return resolve({ ok: false, error: errMsg });
        }
        resolve(response || { ok: true });
      });
    } catch (err) {
      if (err.message && err.message.includes("Extension context invalidated")) {
        _extensionContextDead = true;
      }
      resolve({ ok: false, error: err.message || "Unknown error" });
    }
  });
}

async function loadMonitoringFlag() {
  const st = await chrome.storage.local.get(["monitoringEnabled"]);
  monitoringEnabled = st.monitoringEnabled === true;
  console.log(`[BlocklistGuard] Monitoring enabled: ${monitoringEnabled}`);
  // Run video_id check immediately on load — but not if a capture is already in
  // progress (can happen when the content script is freshly injected mid-capture).
  if (!window.__captureInProgress) {
    (async () => { try { await checkVideoIdOnPage(); } catch (e) { } })();
  }
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

function isMediaEl(el) {
  return el && (el.tagName === "IMG" || el.tagName === "VIDEO");
}

function markMatched(el) {
  if (el.dataset.deepfakeMatched === "1") return;
  el.dataset.deepfakeMatched = "1";
  el.style.outline = "2px solid rgba(22,240,122,.6)";
  el.style.outlineOffset = "2px";
}

/**
 * Clears old blocking overlays and state flags. Crucial for SPA navigations 
 * where YouTube recycles the same <video> node for a new video.
 */
function unblockAllMedia() {
  Array.from(document.querySelectorAll("[data-deepfake-blocked]")).forEach(el => {
    delete el.dataset.deepfakeBlocked;
    el._deepfakeBlocked = false;
  });

  Array.from(document.querySelectorAll("[data-deepfake-overlay]")).forEach(el => el.remove());

  Array.from(document.querySelectorAll("[data-deepfake-card-checked]")).forEach(el => {
    delete el.dataset.deepfakeCardChecked;
  });

  Array.from(document.querySelectorAll("[data-deepfake-thumb-blocked]")).forEach(el => {
    delete el.dataset.deepfakeThumbBlocked;
  });

  Array.from(document.querySelectorAll("[data-deepfake-hover-bound]")).forEach(el => {
    delete el.dataset.deepfakeHoverBound;
  });
}
/**
 * Stops a video element from playing — and keeps it stopped.
 * Uses YouTube's internal API if available, plus HTML5 video aggressive pausing.
 */
function enforceVideoPause(video) {
  if (window.__captureInProgress) {
    console.log("[Capture] enforceVideoPause suppressed - active capture in progress");
    return;
  }
  if (video._deepfakeBlocked) return;
  video._deepfakeBlocked = true;

  const kill = () => {
    try {
      // 1. YouTube specific internal API override
      const ytPlayer = document.getElementById("movie_player");
      if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
        ytPlayer.pauseVideo();
      }

      // 2. Standard HTML5 aggression
      video.pause();
      video.muted = true;
      video.volume = 0;
    } catch (_) { }
  };

  kill(); // immediate
  video.addEventListener("play", (e) => { e.preventDefault(); e.stopImmediatePropagation(); kill(); }, { capture: true });
  video.addEventListener("playing", (e) => { e.preventDefault(); e.stopImmediatePropagation(); kill(); }, { capture: true });

  // Keep enforcing aggressively during startup
  let retryCount = 0;
  const iv = setInterval(() => {
    kill();
    // Clear interval exactly when blocked state is lifted, or after 15 seconds
    if (!video._deepfakeBlocked || ++retryCount >= 30) {
      clearInterval(iv);
    }
  }, 500);
}

/**
 * Build the overlay card DOM element.
 */
function buildOverlay(entry, { compact = false, borderRadius = "8px" } = {}) {
  const overlay = document.createElement("div");
  overlay.dataset.deepfakeOverlay = "1";

  // High-z-index, full width/height strict containment
  overlay.style.cssText = [
    "position: absolute !important",
    "top: 0 !important",
    "left: 0 !important",
    "width: 100% !important",
    "height: 100% !important",
    // Deep dark blur
    "background: rgba(15,15,20,0.92) !important",
    "backdrop-filter: blur(12px) !important",
    "-webkit-backdrop-filter: blur(12px) !important",
    "display: flex !important",
    "flex-direction: column !important",
    "align-items: center !important",
    "justify-content: center !important",
    "gap: " + (compact ? "4px" : "12px") + " !important",
    "z-index: 2147483647 !important", // Max possible
    "border-radius: " + borderRadius + " !important",
    "pointer-events: auto !important",
    "cursor: not-allowed !important",
    "box-shadow: inset 0 0 0 " + (compact ? "2px" : "3px") + " " + window.VERDICT_CONFIG.FAKE.color + " !important",
    "overflow: hidden !important",
    "text-align: center !important",
    "padding: " + (compact ? "12px" : "32px") + " !important",
    "box-sizing: border-box !important",
    "margin: 0 !important"
  ].join(";");

  // Prevent ANY click from passing through this overlay to YouTube
  overlay.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, { capture: true });

  if (!compact) {
    const icon = document.createElement("div");
    icon.textContent = "🚫";
    icon.style.cssText = "font-size:3.5rem !important; line-height:1 !important; margin-bottom:8px !important; pointer-events:none !important;";
    overlay.appendChild(icon);
  }

  const heading = document.createElement("div");
  heading.textContent = compact ? "Blocked" : "Blocked: Suspected Deepfake";
  heading.style.cssText = `color: ${window.VERDICT_CONFIG.FAKE.color} !important; font-weight: 800 !important; font-size: ${compact ? "1rem" : "1.4rem"} !important; letter-spacing: 0.02em !important; font-family: system-ui, sans-serif !important; pointer-events:none !important; text-transform: uppercase !important;`;
  overlay.appendChild(heading);

  if (compact) {
    const sub = document.createElement("div");
    sub.textContent = "Suspected Deepfake";
    sub.style.cssText = "color: #f87171 !important; font-size: 0.8rem !important; font-family: system-ui, sans-serif !important; font-weight: 600 !important; margin-top: 2px !important; pointer-events:none !important;";
    overlay.appendChild(sub);
  }

  if (entry?.title && !compact) {
    const titleEl = document.createElement("div");
    titleEl.textContent = `"${entry.title.slice(0, 80)}${entry.title.length > 80 ? "…" : ""}"`;
    titleEl.style.cssText = "color: #d4d4d8 !important; font-size: 1.05rem !important; max-width: 400px !important; line-height: 1.5 !important; font-family: system-ui, sans-serif !important; font-style: italic !important; margin: 4px 0 !important; pointer-events:none !important;";
    overlay.appendChild(titleEl);
  }

  const meta = document.createElement("div");
  const metaParts = [];
  if (entry?.platform && !compact) metaParts.push(`Platform: ${entry.platform}`);
  if (entry?.risk_score != null) metaParts.push(`Risk: ${entry.risk_score}%`);
  if (metaParts.length) {
    meta.textContent = metaParts.join(" · ");
    meta.style.cssText = `color: #a1a1aa !important; font-size: ${compact ? "0.8" : "0.95"}rem !important; font-family: system-ui, sans-serif !important; font-weight: 500 !important; pointer-events:none !important;`;
    overlay.appendChild(meta);
  }

  if (!compact) {
    const link = document.createElement("a");
    link.textContent = "View details in active portal →";
    link.href = "http://localhost:5173/media-analysis";
    link.target = "_blank";
    link.style.cssText = "color: #60a5fa !important; font-size: 0.95rem !important; margin-top: 12px !important; text-decoration: none !important; font-weight: 600 !important; font-family: system-ui, sans-serif !important; cursor: pointer !important; padding: 8px 16px !important; background: rgba(37,99,235,0.1) !important; border-radius: 6px !important; border: 1px solid rgba(59,130,246,0.3) !important;";

    // Explicit pointer events so it CAN be clicked
    link.style.pointerEvents = "auto";

    link.onmouseover = () => link.style.background = "rgba(37,99,235,0.2)";
    link.onmouseleave = () => link.style.background = "rgba(37,99,235,0.1)";
    link.addEventListener("click", e => e.stopPropagation()); // don't trigger the blocker's stopImmediatePropagation
    overlay.appendChild(link);
  }

  return overlay;
}

/**
 * Block the main YouTube watch-page video player.
 */
function blockWatchPageVideo(video, entry) {
  if (window.__captureInProgress) {
    console.log("[Capture] blockWatchPageVideo suppressed - active capture in progress");
    return;
  }
  enforceVideoPause(video);

  const playerContainer =
    document.getElementById("movie_player") ||
    document.querySelector(".html5-video-player") ||
    video.parentElement;

  if (!playerContainer) return;
  if (playerContainer.dataset.deepfakeBlocked === "1") return;
  playerContainer.dataset.deepfakeBlocked = "1";

  // Force relative positioning so the 100% absolute overlay doesn't escape out to the body
  if (window.getComputedStyle(playerContainer).position === "static") {
    playerContainer.style.setProperty("position", "relative", "important");
  }

  const br = window.getComputedStyle(playerContainer).borderRadius || "0px";
  const overlay = buildOverlay(entry, { compact: false, borderRadius: br });
  playerContainer.appendChild(overlay);

  // Kill clicks at the container level to completely disable player controls
  playerContainer.addEventListener("click", e => {
    if (!e.target.closest("a")) { // allow the portal link
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
}

/**
 * Generic blockElement for thumbnails/cards.
 */
function blockElement(el, entry) {
  if (window.__captureInProgress) {
    console.log("[Capture] blockElement suppressed - active capture in progress");
    return;
  }
  const elKey = el.dataset.deepfakeBlocked;
  if (elKey === "1") return;
  el.dataset.deepfakeBlocked = "1";

  const isVideo = el.tagName === "VIDEO";

  if (isVideo) {
    enforceVideoPause(el);
    blockWatchPageVideo(el, entry);
    return;
  }

  // ── Structural card (e.g. ytd-rich-item-renderer) ───────────────────────
  if (window.getComputedStyle(el).position === "static") {
    el.style.setProperty("position", "relative", "important");
  }

  // Guarantee a minimum dimensions so flex centering never collapses 
  // (YouTube often uses strictly calculated inner heights)
  const rect = el.getBoundingClientRect();
  if (rect.height < 100) el.style.setProperty("min-height", "180px", "important");

  // Prevent interactions
  el.style.setProperty("pointer-events", "none", "important");
  el.style.setProperty("user-select", "none", "important");

  // Intercept any deep clicks (e.g. YouTube's invisible click-targets)
  el.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, { capture: true });

  const cs = window.getComputedStyle(el);
  const elBR = cs.borderRadius || "12px";

  // Append a heavy blur overlay over the entire card
  const overlay = buildOverlay(entry, { compact: true, borderRadius: elBR });
  el.appendChild(overlay);
}

function drawToCanvasFromImg(img) {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  return ctx.getImageData(0, 0, 32, 32);
}
function drawToCanvasFromVideo(video) {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 32);
  return ctx.getImageData(0, 0, 32, 32);
}
function aHash(imageData) {
  const { data } = imageData;
  const gray = [];
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    gray.push(g); sum += g;
  }
  const avg = sum / gray.length;
  let bits = "";
  for (const g of gray) bits += (g >= avg ? "1" : "0");
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function stopYouTubeHoverPreview(card) {
  if (!card) return;

  const previewSelectors = [
    "video",
    "ytd-moving-thumbnail-renderer",
    "yt-image-banner-view-model",
    "div#mouseover-overlay",
    "div#hover-overlays",
    ".ytd-moving-thumbnail-renderer",
    ".html5-video-container"
  ];

  previewSelectors.forEach(sel => {
    Array.from(card.querySelectorAll(sel)).forEach(node => {
      try {
        if (node.tagName === "VIDEO") {
          node.pause?.();
          node.currentTime = 0;
          node.muted = true;
          node.volume = 0;
        }
        node.style.setProperty("display", "none", "important");
        node.style.setProperty("visibility", "hidden", "important");
        node.style.setProperty("opacity", "0", "important");
      } catch (_) { }
    });
  });
}

function suppressHoverPreviewEvents(target) {
  if (!target || target.dataset.deepfakeHoverBound === "1") return;
  target.dataset.deepfakeHoverBound = "1";

  const killHover = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    stopYouTubeHoverPreview(
      target.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer") || target
    );
  };

  [
    "mouseenter",
    "mouseover",
    "mousemove",
    "pointerenter",
    "pointerover",
    "pointermove",
    "mousedown",
    "mouseup",
    "click"
  ].forEach(evt => {
    target.addEventListener(evt, killHover, { capture: true });
  });
}

function blockYouTubeThumbnailCard(card, thumbHost, entry) {
  if (!card) return;
  if (card.dataset.deepfakeThumbBlocked === "1") return;
  card.dataset.deepfakeThumbBlocked = "1";

  const thumbnailBox =
    thumbHost ||
    card.querySelector("#thumbnail") ||
    card.querySelector("ytd-thumbnail") ||
    card;

  if (window.getComputedStyle(card).position === "static") {
    card.style.setProperty("position", "relative", "important");
  }

  if (window.getComputedStyle(thumbnailBox).position === "static") {
    thumbnailBox.style.setProperty("position", "relative", "important");
  }

  // Disable navigation/clicks
  const clickableEls = card.querySelectorAll("a, button, yt-icon-button");
  Array.from(clickableEls).forEach(node => {
    node.style.setProperty("pointer-events", "none", "important");
  });

  // Hide all thumbnail images, not just one
  const imgs = card.querySelectorAll("img, yt-image img");
  Array.from(imgs).forEach(img => {
    img.style.setProperty("visibility", "hidden", "important");
    img.style.setProperty("opacity", "0", "important");
  });

  // Hide preview/moving thumbnail parts immediately
  stopYouTubeHoverPreview(card);

  const thumbImageWrap =
    card.querySelector("ytd-thumbnail") ||
    card.querySelector("#thumbnail") ||
    thumbnailBox;

  if (thumbImageWrap) {
    thumbImageWrap.style.setProperty("background", "#0f0f14", "important");
    thumbImageWrap.style.setProperty("overflow", "hidden", "important");
  }

  const existing = thumbnailBox.querySelector("[data-deepfake-overlay='1']");
  if (existing) return;

  const overlay = buildOverlay(entry, {
    compact: true,
    borderRadius: "12px"
  });

  overlay.style.setProperty("position", "absolute", "important");
  overlay.style.setProperty("top", "0", "important");
  overlay.style.setProperty("left", "0", "important");
  overlay.style.setProperty("width", "100%", "important");
  overlay.style.setProperty("height", "100%", "important");
  overlay.style.setProperty("z-index", "2147483647", "important");
  overlay.style.setProperty("pointer-events", "auto", "important");

  // Block hover-triggered preview on card, thumbnail, and overlay
  suppressHoverPreviewEvents(card);
  suppressHoverPreviewEvents(thumbnailBox);
  suppressHoverPreviewEvents(overlay);

  thumbnailBox.appendChild(overlay);

  // Re-kill preview if YouTube injects it slightly later
  setTimeout(() => stopYouTubeHoverPreview(card), 0);
  setTimeout(() => stopYouTubeHoverPreview(card), 300);
  setTimeout(() => stopYouTubeHoverPreview(card), 1000);
}

async function bumpCounter(key, inc = 1) {
  const st = await chrome.storage.local.get([key]);
  await chrome.storage.local.set({ [key]: (st[key] ?? 0) + inc });
}

async function fingerprintElement(el) {
  if (el.tagName === "IMG") {
    if (!el.complete || el.naturalWidth === 0) return null;
    return aHash(drawToCanvasFromImg(el));
  }
  if (el.tagName === "VIDEO") {
    if (el.readyState < 2) return null;
    return aHash(drawToCanvasFromVideo(el));
  }
  return null;
}

async function processMedia(el) {
  if (window.__captureInProgress) return;

  // If the whole page/video_id is actively blocked, block this element immediately
  if (window._blockedEntry) {
    blockElement(el, window._blockedEntry);
    return;
  }

  if (!monitoringEnabled) return;
  try {
    const hash = await fingerprintElement(el);
    if (!hash) return;

    console.log(`[BlocklistGuard] aHash generated for <${el.tagName}>: ${hash}`);
    await bumpCounter("scanned", 1);

    const entry = await getBlocklistEntry(hash);
    if (entry) {
      blockElement(el, entry);
      await bumpCounter("blocked", 1);
    }

    Promise.resolve(safeSendMessage({ type: "COUNTS_UPDATED" })).catch(() => { });
  } catch (err) {
    // canvas/CORS issues; skip silently
    console.debug("[BlocklistGuard] processMedia skip:", err?.message);
  }
}

var _fingerprintCache = new Map();
async function getBlocklistEntry(hash) {
  if (_fingerprintCache.has(hash)) return _fingerprintCache.get(hash);
  try {
    const res = await safeSendMessage({ type: "CHECK_FINGERPRINT_BLOCKLIST", hash });
    if (!res?.ok || !res?.entry) {
      _fingerprintCache.set(hash, null);
      return null;
    }
    const { entry } = res;
    _fingerprintCache.set(hash, entry);
    console.log(`[BlocklistGuard] ✅ SW match for hash: ${hash} → ${entry.title || entry.video_id || "??"}`);
    return entry;
  } catch (err) {
    console.warn("[BlocklistGuard] getBlocklistEntry SW query error:", err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER B — Thumbnail Perceptual Hash (pHash) Matching
// Catches reposted / reformatted variants that have a different video_id
// but a visually similar thumbnail image.
// ═══════════════════════════════════════════════════════════════════════

/** Hamming distance between two hex-encoded pHash strings */
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    // Count set bits in 4-bit nibble
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

/**
 * Compute perceptual hash from an ImageData object (32×32 DCT-based pHash).
 * Returns a 16-char hex string (64 bits).
 */
function pHashFromImageData(imageData) {
  const SIZE = 32;
  // Grayscale
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const off = i * 4;
    gray[i] = imageData.data[off] * 0.299 + imageData.data[off + 1] * 0.587 + imageData.data[off + 2] * 0.114;
  }

  // 2D DCT (only compute the top-left 8×8 frequencies)
  const dct = new Float32Array(8 * 8);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
          sum += gray[x * SIZE + y] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * SIZE));
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      dct[u * 8 + v] = (2 / SIZE) * cu * cv * sum;
    }
  }

  // Median as threshold (skip DC component at index 0)
  const sorted = dct.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Build bit hash, convert to hex nibbles
  let bits = "";
  for (let i = 1; i < 65; i++) bits += dct[i] >= median ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex; // 16 hex chars = 64 bits
}

/**
 * Load an image URL into a 32×32 canvas and compute its pHash.
 * Returns null on CORS / load errors.
 */
function computeThumbnailPHash(imgUrl) {
  return new Promise(resolve => {
    if (!imgUrl) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";

    const timeout = setTimeout(() => resolve(null), 4000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 32, 32);
        const imageData = ctx.getImageData(0, 0, 32, 32);
        resolve(pHashFromImageData(imageData));
      } catch (_) {
        resolve(null);
      }
    };

    img.onerror = () => { clearTimeout(timeout); resolve(null); };
    img.src = imgUrl;
  });
}

// In-memory cache of all blocklist entries for Layer B.
// Refreshed when blocklist is synced or on page load (max 5 min stale).
var _blocklistCache = null;
var _blocklistCacheTs = 0;
var CACHE_TTL_MS = 5 * 60 * 1000;

// ── NEW: Video ID result cache ───────────────────────────────────────────────
// Prevents repeated CHECK_VIDEO_ID_BLOCKLIST messages to the service worker.
// _videoIdBlocked: Map<videoId, blocklist entry>  — confirmed BLOCKED
// _videoIdClean:   Set<videoId>                   — confirmed CLEAN
var _videoIdBlocked = new Map();
var _videoIdClean = new Set();
var blockCache = new Map();

/** Clear videoId caches on navigation so a new page gets a fresh check. */
function clearVideoIdCache() {
  _videoIdBlocked.clear();
  _videoIdClean.clear();
  blockCache.clear();
}

/**
 * NEW: In-memory cache for blocklist lookups via SW.
 */
async function checkBlocklist(videoId) {
  if (blockCache.has(videoId)) return blockCache.get(videoId);

  const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
  const entry = (res?.ok && res?.entry) ? res.entry : null;

  blockCache.set(videoId, entry);
  return entry;
}

// ── NEW: Scheduler / debounce for scanning ───────────────────────────────────
// Instead of calling scanYouTubeCards() synchronously inside every mutation,
// we batch pending roots and flush at most once every SCAN_DEBOUNCE_MS.
var SCAN_DEBOUNCE_MS = 200;
var _scanScheduled = false;
/** Pending root elements queued by the MutationObserver (null = full doc). */
var _pendingScanRoots = new Set();

/**
 * NEW — Schedule a (debounced) scan pass.
 * @param {Element|Document|null} root  Pass null to request a full-document scan.
 */
function scheduleScan(root) {
  if (!location.hostname.includes("youtube.com")) return;
  // null means "scan document" — coarses out any individual roots already queued
  if (root == null) {
    _pendingScanRoots.clear();
    _pendingScanRoots.add(null);
  } else if (!_pendingScanRoots.has(null)) {
    _pendingScanRoots.add(root);
  }
  if (_scanScheduled) return;
  _scanScheduled = true;
  setTimeout(() => {
    _scanScheduled = false;
    const roots = Array.from(_pendingScanRoots);
    _pendingScanRoots.clear();
    for (const r of roots) {
      try { scanYouTubeCards(r == null ? document : r); } catch (_) { }
    }
  }, SCAN_DEBOUNCE_MS);
}

// ── NEW: Processed-node guard ─────────────────────────────────────────────────
// Tracks DOM nodes already handed to processYouTubeCard() so the scheduler
// never re-queues the same card during rapid scroll / layout mutations.
var _processedNodes = new WeakSet();

// Threshold: Hamming distance ≤ 10 out of 64 bits (~84% similarity) is treated as a match.

async function getBlocklistCache() {
  if (_blocklistCache && (Date.now() - _blocklistCacheTs) < CACHE_TTL_MS) {
    return _blocklistCache;
  }
  try {
    const res = await safeSendMessage({ type: "GET_ALL_BLOCKLIST_ENTRIES" });
    if (res?.ok && Array.isArray(res.entries)) {
      _blocklistCache = res.entries;
      _blocklistCacheTs = Date.now();
      return _blocklistCache;
    }
  } catch (err) {
    console.debug("[BlocklistGuard] Layer B cache fetch error:", err?.message);
  }
  return [];
}

/** Invalidate the cache when a new sync arrives */
function invalidateBlocklistCache() {
  _blocklistCache = null;
  _blocklistCacheTs = 0;
}

// Threshold: Hamming distance ≤ 10 out of 64 bits (~84% similarity) is treated as a match.
var PHASH_HAMMING_THRESHOLD = 10;

/**
 * LAYER B — Check if a card's thumbnail pHash visually matches any blocked entry.
 * @param {Element} card — the ytd-*-renderer element
 * @param {Element} thumbHost — the #thumbnail or ytd-thumbnail element
 * @param {string} videoId — already-checked Layer A video_id (CLEAN at this point)
 * @returns {Promise<boolean>} true if blocked by Layer B
 */
async function checkThumbnailPHashLayer(card, thumbHost, videoId) {
  if (!card || card.dataset.deepfakeThumbBlocked === "1") return false;

  // Find the thumbnail image src
  const imgEl =
    thumbHost?.querySelector("img") ||
    card.querySelector("img") ||
    card.querySelector("yt-image img");

  if (!imgEl?.src || imgEl.src.startsWith("data:")) return false;

  // Fetch blocked entry list
  const entries = await getBlocklistCache();
  const entriesWithHash = entries.filter(e => e.thumbnail_phash);
  if (entriesWithHash.length === 0) return false;

  console.log(`[BlocklistGuard][LayerB] Computing pHash for card video_id: ${videoId}`);
  const thumbHash = await computeThumbnailPHash(imgEl.src);
  if (!thumbHash) {
    console.debug(`[BlocklistGuard][LayerB] pHash failed (CORS?) for ${imgEl.src.slice(0, 60)}`);
    return false;
  }

  for (const entry of entriesWithHash) {
    const dist = hammingDistance(thumbHash, entry.thumbnail_phash);
    if (dist <= PHASH_HAMMING_THRESHOLD) {
      console.log(`[BlocklistGuard][LayerB] 🚫 MATCH! card video_id "${videoId}" ~ blocked "${entry.video_id}" (Hamming ${dist}/64). Blocking.`);
      const syntheticEntry = {
        ...entry,
        _variantOf: entry.video_id,
        title: entry.title ? `[Variant] ${entry.title}` : "Suspected Deepfake Variant",
      };
      bumpCounter("blocked", 1).catch(() => { });
      Promise.resolve(safeSendMessage({ type: "COUNTS_UPDATED" })).catch(() => { });
      blockYouTubeThumbnailCard(card, thumbHost, syntheticEntry);
      return true;
    }
  }

  console.debug(`[BlocklistGuard][LayerB] No pHash match for card video_id: ${videoId} (best dist > ${PHASH_HAMMING_THRESHOLD})`);
  return false;
}

async function checkVideoIdOnPage() {
  if (window.__captureInProgress) {
    console.log("[Blocklist] Skip page-level block during active capture");
    return;
  }
  // URL-based early block — runs before media loads.
  try {
    const url = location.href;
    let videoId = null;
    const ytShorts = url.match(/\/shorts\/([^/?]+)/);
    if (ytShorts) videoId = ytShorts[1];
    else {
      try { videoId = new URL(url).searchParams.get("v"); } catch (_) { }
    }
    if (!videoId) {
      console.log("[BlocklistGuard] No video_id found in current URL, skipping early block.");
      return;
    }

    console.log(`[BlocklistGuard] Asking SW to check video_id: ${videoId}`);
    const entry = await checkBlocklist(videoId);

    if (entry) {
      console.log(`[BlocklistGuard] 🚫 video_id "${videoId}" is BLOCKED. Title: "${entry.title || '?'}". Applying overlay.`);
      window._blockedEntry = entry;
      document.querySelectorAll("video").forEach(v => {
        blockElement(v, entry);
      });
      await bumpCounter("blocked", 1);
      Promise.resolve(safeSendMessage({ type: "COUNTS_UPDATED" })).catch(() => { });
    } else {
      console.log(`[BlocklistGuard] video_id "${videoId}" is CLEAN.`);
      window._blockedEntry = null;
    }
  } catch (err) {
    console.warn("[BlocklistGuard] checkVideoIdOnPage query error:", err);
  }
} // End of checkVideoIdOnPage

// ── YouTube Card Detection Helpers ──────────────────────────────────────────

/**
 * All YouTube card renderers we want to scan.
 * Includes standard video cards, Shorts shelf cells, and newer yt-lockup-view-model.
 */
var YT_CARD_SELECTORS = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-reel-item-renderer",
  "ytd-rich-grid-slim-media",  // Shorts shelf grid cell
  "ytd-shorts",               // Shorts page full card
  "yt-lockup-view-model",     // New YouTube UI Shorts lockup
  "ytd-reel-shelf-renderer",  // Entire Shorts shelf (recurse into children)
].join(", ");

/**
 * Walk ALL anchors inside a card and extract the first valid YouTube video_id.
 * Supports /shorts/<id> and /watch?v=<id>.
 * Returns { videoId, isShorts } or null.
 */
function extractYouTubeCardVideoId(card) {
  const anchors = Array.from(card.querySelectorAll("a[href]"));
  if (card.tagName === "A" && card.getAttribute("href")) anchors.unshift(card);

  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    const shortsMatch = href.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/);
    if (shortsMatch) return { videoId: shortsMatch[1], isShorts: true };
    try {
      const u = new URL(href, "https://www.youtube.com");
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        if (v) return { videoId: v, isShorts: false };
      }
    } catch (_) { }
  }
  return null;
}

/**
 * Find the best thumbnail image for pHash computation.
 * Handles lazy-loaded and deeply nested Shorts thumbnails.
 */
function findBestThumbnailImage(card) {
  const prioritySelectors = [
    "ytd-thumbnail img",
    "#thumbnail img",
    "yt-image img",
    "img#img",
    "img.yt-core-image",
    "img[src*='ytimg.com']",
    "img[src*='i.ytimg.com']",
  ];
  for (const sel of prioritySelectors) {
    const img = card.querySelector(sel);
    if (img?.src && !img.src.startsWith("data:") && img.naturalWidth !== 0) return img;
  }
  for (const img of card.querySelectorAll("img")) {
    if (img.src && !img.src.startsWith("data:") && img.naturalWidth !== 0) return img;
  }
  return null;
}

/** Find the visual container element for overlay placement. */
function getThumbHost(card) {
  return (
    card.querySelector("ytd-thumbnail") ||
    card.querySelector("#thumbnail") ||
    card.querySelector("yt-image") ||
    card
  );
}

// MODIFIED — processYouTubeCard: uses videoId cache + visibility guard for Layer B
async function processYouTubeCard(card) {
  if (window.__captureInProgress) return;
  // ── Guard: already fully processed ──────────────────────────────────────
  if (_processedNodes.has(card)) return;
  if (card.dataset.deepfakeThumbBlocked === "1") return;
  if (card.dataset.deepfakeCardChecked === "1") return;

  const result = extractYouTubeCardVideoId(card);
  const thumbHost = getThumbHost(card);
  const imgEl = findBestThumbnailImage(card);

  // If we lack BOTH videoId and a thumbnail image we cannot do anything yet.
  // Schedule a single retry but do NOT mark the card so it stays in the queue.
  if (!result && !imgEl) {
    setTimeout(() => {
      if (!_processedNodes.has(card)) processYouTubeCard(card);
    }, 1500);
    return;
  }

  // ── Permanently mark as in-progress / done — prevents all future re-runs ─
  _processedNodes.add(card);
  card.dataset.deepfakeCardChecked = "1";

  try {
    const videoId = result ? result.videoId : "unknown";
    const isShorts = result ? result.isShorts : false;

    // ── LAYER A: exact video_id check (with cache) ───────────────────────
    if (result) {
      // HIT: already known BLOCKED
      if (_videoIdBlocked.has(videoId)) {
        console.log(`[BlocklistGuard] [LayerA][cache-hit] Blocking ${isShorts ? "Shorts" : "video"} card: ${videoId}`);
        blockYouTubeThumbnailCard(card, thumbHost, _videoIdBlocked.get(videoId));
        return;
      }
      // HIT: already known CLEAN → skip directly to Layer B
      if (!_videoIdClean.has(videoId)) {
        // MISS: first time seeing this videoId → ask the service worker
        console.log(`[BlocklistGuard] Scanning ${isShorts ? "[Shorts]" : "[Video]"} card video_id: ${videoId}`);
        const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
        if (res?.ok && res?.entry) {
          _videoIdBlocked.set(videoId, res.entry);
          console.log(`[BlocklistGuard] 🚫 [LayerA] Blocking ${isShorts ? "Shorts" : "video"} card: ${videoId}`);
          blockYouTubeThumbnailCard(card, thumbHost, res.entry);
          return;
        }
        // Clean — cache it so future cards with the same id skip the SW call
        _videoIdClean.add(videoId);
      }
    } else {
      console.debug("[BlocklistGuard] No videoId on card; trying Layer B only.");
    }

    // ── LAYER B: thumbnail pHash (only when card is visible on screen) ────
    if (!imgEl) {
      // No image yet — schedule a single retry (card is still un-fully-processed
      // re: Layer B, but we already cached the Layer A clean result).
      _processedNodes.delete(card);          // allow one more attempt
      delete card.dataset.deepfakeCardChecked;
      setTimeout(() => {
        if (!_processedNodes.has(card)) processYouTubeCard(card);
      }, 1500);
      return;
    }

    // Visibility guard — skip pHash for off-screen cards (expensive!)
    const rect = card.getBoundingClientRect();
    const isVisible = rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
    if (!isVisible) {
      // Re-allow processing once the card scrolls into view
      _processedNodes.delete(card);
      delete card.dataset.deepfakeCardChecked;
      return;
    }

    await checkThumbnailPHashLayer(card, thumbHost, videoId);
  } catch (err) {
    console.debug("[BlocklistGuard] processYouTubeCard error:", err?.message);
  }
}

// MODIFIED — scanYouTubeCards: skips already-processed nodes early
function scanYouTubeCards(root = document) {
  if (window.__captureInProgress) return;
  if (!location.hostname.includes("youtube.com")) return;

  const candidates = [];
  if (root instanceof Element && root.matches(YT_CARD_SELECTORS)) {
    candidates.push(root);
  }
  if (typeof root.querySelectorAll === "function") {
    Array.from(root.querySelectorAll(YT_CARD_SELECTORS)).forEach(el => candidates.push(el));
  }

  for (const card of candidates) {
    // Fast-skip: WeakSet membership check is O(1)
    if (_processedNodes.has(card)) continue;
    // Shelf containers: recurse into children instead of treating the shelf as a card
    if (card.tagName.toLowerCase() === "ytd-reel-shelf-renderer") {
      scanYouTubeCards(card);
      continue;
    }
    processYouTubeCard(card);
  }
}


function scanExisting() {
  if (window.__captureInProgress) return;

  if (monitoringEnabled) {
    Array.from(document.querySelectorAll("img,video")).forEach(el => {
      (async () => { try { await processMedia(el); } catch (e) { } })();
    });
  }

  if (location.hostname.includes("youtube.com")) {
    (async () => { try { await scanYouTubeCards(document); } catch (e) { } })();
  }

  (async () => { try { await checkVideoIdOnPage(); } catch (e) { } })();
}

function scanThumbnails(root = null) {
  if (location.hostname.includes("youtube.com")) {
    try { scanYouTubeCards(root == null ? document : root); } catch (_) { }
    try { checkVideoIdOnPage(); } catch (_) { }
  }
}

// MODIFIED — MutationObserver: lightweight, delegates heavy work to scheduler
var scanTimeout;
var mo = new MutationObserver((mutations) => {
  if (window.__captureInProgress) return;
  try {
    // ── SPA navigation detection (cheapest check first) ─────────────────
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      console.log("[BlocklistGuard] URL changed:", currentUrl);
      unblockAllMedia();
      invalidateBlocklistCache();
      clearVideoIdCache();

      // Debounced full page check on navigation
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => scanThumbnails(null), 300);
      return;
    }

    // ── Check if any relevant changes occurred ───
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => scanThumbnails(null), 300);
        break;
      }
    }
  } catch (err) {
    console.warn("[BlocklistGuard] MutationObserver error:", err);
  }
});

// Defense in depth for slow-loading SPA players
window.addEventListener("load", () => {
  console.log("[BlocklistGuard] load event fired, running final check...");
  (async () => { try { await checkVideoIdOnPage(); } catch (e) { } })();
});
setTimeout(() => { if (!window.__captureInProgress) (async () => { try { await checkVideoIdOnPage(); } catch (e) { } })(); }, 1500);
setTimeout(() => { if (!window.__captureInProgress) (async () => { try { await checkVideoIdOnPage(); } catch (e) { } })(); }, 3500);

function getPlatform() {
  const h = location.hostname;
  if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
  if (h.includes("tiktok.com")) return "tiktok";
  if (h.includes("facebook.com") || h.includes("fb.watch")) return "facebook";
  return "other";
}

function getYouTubeTitle() {
  const h1 = document.querySelector("h1.ytd-watch-metadata");
  const t1 = h1?.innerText?.trim();
  if (t1) return t1;
  const meta = document.querySelector('meta[name="title"]')?.getAttribute("content")?.trim();
  if (meta) return meta;
  return document.title || "";
}

function getVideoTimestamp() {
  const vids = Array.from(document.querySelectorAll("video"));
  vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  const v = vids.find(x => x.readyState >= 2) || vids[0];
  if (!v) return 0;
  return Number(v.currentTime || 0);
}

function getYouTubeTimestamp() {
  const main = document.querySelector("video.html5-main-video");
  if (main && Number.isFinite(main.currentTime)) return Number(main.currentTime || 0);
  return getVideoTimestamp();
}

function getYouTubeCurrentVideoIdAndContext() {
  const shortsMatch = location.pathname.match(/\/shorts\/([^/?]+)/);
  if (shortsMatch?.[1]) return { videoId: shortsMatch[1], context: "shorts" };

  const v = new URL(location.href).searchParams.get("v");
  if (v) return { videoId: v, context: "watch" };

  const miniLink =
    document.querySelector('ytd-miniplayer a[href*="watch?v="]') ||
    document.querySelector('ytd-miniplayer a[href*="/shorts/"]');

  const href = miniLink?.getAttribute("href") || "";
  const mWatch = href.match(/[?&]v=([^&]+)/);
  if (mWatch?.[1]) return { videoId: mWatch[1], context: "miniplayer" };

  const mShorts = href.match(/\/shorts\/([^/?]+)/);
  if (mShorts?.[1]) return { videoId: mShorts[1], context: "miniplayer" };

  const flexy = document.querySelector("ytd-watch-flexy[video-id]");
  const flexyId = flexy?.getAttribute("video-id");
  if (flexyId) return { videoId: flexyId, context: "watch" };

  return { videoId: null, context: null };
}

function buildYouTubeCanonicalUrl(videoId, context) {
  if (!videoId) return null;
  if (context === "shorts") return `https://www.youtube.com/shorts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getSafeVideo() {
  const videos = document.querySelectorAll("video");
  let best = null;
  let maxArea = 0;

  videos.forEach(v => {
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;

    if (
      area > maxArea &&
      rect.width > 200 &&
      rect.height > 150 &&
      v.readyState >= 2
    ) {
      best = v;
      maxArea = area;
    }
  });

  return best;
}

function getBestVideoElementForRect() {
  return getSafeVideo();
}

/**
 * Returns the best video element to use as the capture source.
 * For Shorts: locks onto the currently-active reel element at capture-start time.
 * Keeping a reference to this specific element means drawImage() keeps working
 * even if the user scrolls to a different Short mid-capture.
 */
function findVideoElementForCapture(lockedVideoId) {
  const isShorts = location.pathname.includes('/shorts/');

  console.log("[Capture DEBUG] Attempting to lock video:", { lockedVideoId });

  if (isShorts) {
    // Primary: the active reel renderer's <video>
    const active =
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('ytd-reel-video-renderer[is-active]')?.querySelector('video');
    if (active) return active;
  }

  // Prefer the real main YouTube player on watch pages
  const main =
    document.querySelector("#movie_player video.html5-main-video") ||
    document.querySelector(".html5-video-player video") ||
    document.querySelector("video.html5-main-video");

  if (main && main.readyState >= 2 && main.videoWidth > 0 && main.videoHeight > 0) {
    return main;
  }

  return getSafeVideo();
}


function getTikTokVideoId() {
  const m = location.href.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function getFacebookVideoId() {
  const u = new URL(location.href);
  const v = u.searchParams.get("v");
  if (v) return v;
  const m = location.href.match(/fb\.watch\/([^/?]+)/);
  return m ? m[1] : null;
}

function pickBestVisibleMediaEl() {
  const vids = Array.from(document.querySelectorAll("video"))
    .filter(v => v.offsetParent !== null);
  vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  if (vids[0]) return vids[0];

  const imgs = Array.from(document.querySelectorAll("img"))
    .filter(img => img.offsetParent !== null && img.naturalWidth > 150 && img.naturalHeight > 150);
  imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
  return imgs[0] || null;
}

function findClosestPostRoot(el) {
  if (!el) return null;
  return el.closest('div[role="article"]') || el.closest('div[data-pagelet]') || el.parentElement;
}

function absolutizeUrl(href) {
  try { return new URL(href, location.origin).toString(); }
  catch { return null; }
}

function extractFacebookIdFromUrl(url) {
  if (!url) return null;
  let m = url.match(/\/reel\/(\d+)/);
  if (m) return m[1];
  m = url.match(/\/videos\/(\d+)/);
  if (m) return m[1];
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v && /^\d+$/.test(v)) return v;
    const fbid = u.searchParams.get("fbid");
    if (fbid && /^\d+$/.test(fbid)) return fbid;
  } catch { }
  m = url.match(/story_fbid=(\d+)/);
  if (m) return m[1];
  return null;
}

function findFacebookPostUrlFromDom() {
  const media = pickBestVisibleMediaEl();
  const root = findClosestPostRoot(media);
  if (!root) return { post_url: null, post_id: null };

  const links = Array.from(root.querySelectorAll('a[href]'))
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(absolutizeUrl)
    .filter(Boolean);

  const candidates = links.filter(u =>
    u.includes("/reel/") ||
    u.includes("/videos/") ||
    u.includes("/watch/?v=") ||
    u.includes("photo.php?") ||
    u.includes("story.php?")
  );

  const post_url = candidates[0] || null;
  const post_id = extractFacebookIdFromUrl(post_url);
  return { post_url, post_id };
}

function getMainVideoEl() {
  return getBestVideoElementForRect() || document.querySelector("video.html5-main-video") || document.querySelector("video");
}

async function safePlayMuted(v) {
  if (!v) return false;
  try {
    v.muted = true;
    v.playsInline = true;
    await v.play();
    return true;
  } catch {
    return false;
  }
}

async function waitForVideoReady(video = null, timeoutMs = 12000, lockedVideoId = null) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let v = null;

    if (
      video &&
      video.isConnected &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      v = video;
    } else {
      v = findVideoElementForCapture(lockedVideoId) || getMainVideoEl();
    }

    if (v) {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        try {
          await waitForPresentedVideoFrame(v, 800);
        } catch {
          await wait(100);
        }

        if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) {
          return {
            ok: true,
            ready: true,
            video: v,
            w: v.videoWidth,
            h: v.videoHeight,
            ts: Number(v.currentTime || 0)
          };
        }
      }
    }
    await wait(150);
  }

  return { ok: false, ready: false, error: "timeout_waiting_video_ready" };
}

async function seekTo(v, tSec) {
  if (!v || !Number.isFinite(tSec)) return false;
  if (v.readyState < 1) await wait(200);

  const target = Math.max(0, Number(tSec));
  try {
    await new Promise((resolve) => {
      v.addEventListener("seeked", () => resolve(), { once: true });
      v.currentTime = target;
      setTimeout(resolve, 1200);
    });

    if (typeof v.requestVideoFrameCallback === "function") {
      await new Promise(resolve => {
        v.requestVideoFrameCallback(() => resolve());
        setTimeout(resolve, 400);
      });
    } else {
      await wait(150);
    }
    return true;
  } catch {
    return false;
  }
}


async function waitForPresentedVideoFrame(video, timeoutMs = 1200) {
  if (!video) return false;
  if (typeof video.requestVideoFrameCallback === "function") {
    return await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, timeoutMs);
      video.requestVideoFrameCallback(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  await wait(Math.min(180, timeoutMs));
  return true;
}

function frameStatsFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) {
    return { avgLuma: 0, nonBlackRatio: 0, isMostlyBlack: true };
  }

  // Sample a 64×64 center crop instead of the full frame.
  // For 1920×1080 this cuts getImageData + pixel iteration cost by ~900×
  // while remaining accurate enough to detect mostly-black frames.
  const sw = Math.min(64, canvas.width);
  const sh = Math.min(64, canvas.height);
  const sx = Math.floor((canvas.width - sw) / 2);
  const sy = Math.floor((canvas.height - sh) / 2);
  const { data, width, height } = ctx.getImageData(sx, sy, sw, sh);

  let totalLuma = 0;
  let nonBlack = 0;
  const pixelCount = width * height;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    totalLuma += luma;

    if (luma > 10) nonBlack += 1;
  }

  const avgLuma = pixelCount ? totalLuma / pixelCount : 0;
  const nonBlackRatio = pixelCount ? nonBlack / pixelCount : 0;

  return {
    avgLuma,
    nonBlackRatio,
    isMostlyBlack: avgLuma < 8 || nonBlackRatio < 0.02
  };
}

async function waitUntilNotMostlyBlack(video, canvas, ctx, timeoutMs = 2500, quality = 0.8) {
  const started = Date.now();
  let lastStats = null;

  while (Date.now() - started < timeoutMs) {
    if (
      video.videoWidth > 0 &&
      (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      console.warn("[Capture] drawImage failed:", err);
      await wait(120);
      continue;
    }

    const stats = frameStatsFromCanvas(canvas);
    lastStats = stats;

    if (!stats.isMostlyBlack) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      console.log("[Capture] usable frame captured");
      return {
        ok: true,
        stats,
        dataUrl
      };
    }

    await waitForPresentedVideoFrame(video, 600);
  }

  console.warn("[Capture] frame stayed mostly black until timeout", lastStats);
  return { ok: false, stats: lastStats };
}

async function extractLiveFramesFromVideo(video, {
  frameCount = 8,
  intervalMs = 1000,
  quality = 0.8,
  warmupMs = 350,
  lockedVideoId = null
} = {}) {
  if (!video) return { ok: false, error: "no_video_element" };

  const ready = await waitForVideoReady(video, 12000, lockedVideoId);
  if (!ready.ok) return { ok: false, error: ready.error || "not_ready" };

  video = ready.video || video;

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    console.error("[Capture] Invalid video element: zero dimension");
    return { ok: false, error: "invalid_video" };
  }

  console.log("[Capture] video ready:", {
    width: video.videoWidth,
    height: video.videoHeight,
    currentTime: video.currentTime,
    frameCount,
    intervalMs
  });

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const startedAt = Date.now();
  const frames = [];
  const tsMs = [];
  const perFrame = [];
  let blankCount = 0;
  const MAX_CONSECUTIVE_BLANKS = 4;
  let consecutiveBlankCount = 0;

  await wait(Math.max(0, Number(warmupMs || 0)));

  try {
    await waitForPresentedVideoFrame(video, 1200);
  } catch {
    await wait(100);
  }

  for (let i = 0; i < frameCount; i++) {
    const capture = await waitUntilNotMostlyBlack(video, canvas, ctx, 180, quality);
    const currentTsMs = Math.round(Number(video.currentTime || 0) * 1000);

    if (capture.ok) {
      consecutiveBlankCount = 0;
      frames.push(capture.dataUrl);
      tsMs.push(currentTsMs);
      perFrame.push({
        idx: i,
        tsMs: currentTsMs,
        ok: true,
        avgLuma: capture.stats.avgLuma,
        nonBlackRatio: capture.stats.nonBlackRatio
      });

      console.log(`[Capture] frame ${i} captured at ${currentTsMs}ms`);
    } else {

      consecutiveBlankCount += 1;

      if (consecutiveBlankCount >= MAX_CONSECUTIVE_BLANKS) {
        console.warn("[Capture] Early stop: too many consecutive blank frames");
        break;
      }

      blankCount += 1;
      perFrame.push({
        idx: i,
        tsMs: currentTsMs,
        ok: false,
        reason: "blank_frame",
        avgLuma: capture.stats?.avgLuma ?? 0,
        nonBlackRatio: capture.stats?.nonBlackRatio ?? 0
      });

      console.warn(`[Capture] frame ${i} blank/failed`);
    }

    if (i < frameCount - 1) {
      await wait(intervalMs);
    }
  }

  console.log("[Capture] extraction done:", {
    requested: frameCount,
    captured: frames.length,
    blankCount,
    elapsedMs: Date.now() - startedAt
  });

  return {
    ok: frames.length > 0,
    frames,
    tsMs,
    w: video.videoWidth,
    h: video.videoHeight,
    debug: {
      totalRequested: frameCount,
      capturedCount: frames.length,
      blankCount,
      elapsedMs: Date.now() - startedAt,
      perFrame
    }
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    let responded = false;
    const safeRes = (data) => {
      if (!responded) {
        responded = true;
        try { sendResponse(data); } catch (e) { }
      }
    };
    try {
      const origSendResponse = sendResponse;
      sendResponse = safeRes;
      if (msg?.type === "PING") {
        sendResponse({ ok: true, ready: true, url: location.href });
        return true;
      }

      if (msg?.type === "WAIT_UNTIL_READY") {
        const res = await waitForVideoReady(
          null,
          Number(msg.timeoutMs || 12000),
          msg.lockedVideoId || null
        );
        sendResponse(res);
        return;
      }

      if (msg?.type === "PREP_CAPTURE") {
        // Use a 3 s limit: Chrome extension message channels time out around 5 s,
        // so 12 000 ms caused silent channel drops when the video wasn't ready yet.
        // EXTRACT_FRAMES_LIVE's internal waitForVideoReady handles any remaining
        // wait, so a short PREP_CAPTURE timeout is safe.
        const res = await waitForVideoReady(
          null,
          3000,
          msg.lockedVideoId || null
        );
        sendResponse(res.ok ? { ok: true, ...res } : res);
        return;
      }

      if (msg?.type === "EXTRACT_FRAMES_LIVE") {
        window.__captureInProgress = true;
        stopObserver();
        console.log("[Capture] START - blocking + scanning suspended");

        try {
          const v = findVideoElementForCapture(msg.lockedVideoId);
          if (!v) {
            sendResponse({ ok: false, error: "no_video_element" });
            return;
          }

          const frameCount = Number(msg.frameCount || 8);
          const intervalMs = Number(msg.intervalMs || 1000);
          const quality = Number(msg.quality || 0.8);
          const warmupMs = Number(msg.warmupMs || 350);

          console.log("[Capture] Using video:", {
            readyState: v.readyState,
            w: v.videoWidth,
            h: v.videoHeight,
            currentTime: v.currentTime
          });

          const out = await extractLiveFramesFromVideo(v, {
            frameCount,
            intervalMs: Math.max(90, intervalMs),
            quality,
            warmupMs,
            lockedVideoId: msg.lockedVideoId || null
          });

          console.log("[Capture] Result:", out?.ok, out?.error, out?.debug);
          sendResponse(out);
          return;
        } catch (err) {
          console.error("[Capture] EXTRACT_FRAMES_LIVE failed:", err);
          sendResponse({ ok: false, error: err?.message || "extract_failed" });
          return;
        } finally {
          window.__captureInProgress = false;
          startObserver();
          console.log("[Capture] END - blocking + scanning resumed");
        }
      }

      if (msg?.type === "SET_MONITORING") {
        monitoringEnabled = !!msg.enabled;
        await chrome.storage.local.set({ monitoringEnabled });
        if (monitoringEnabled) startObserver();
        else stopObserver();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "SUSPEND_SCANNING_FOR_CAPTURE") {
        window.__captureInProgress = true;
        stopObserver();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "RESUME_SCANNING_AFTER_CAPTURE") {
        window.__captureInProgress = false;
        startObserver();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "GET_CURRENT_TS") {
        const platform = getPlatform();
        const ts = platform === "youtube" ? getYouTubeTimestamp() : getVideoTimestamp();
        sendResponse({ ok: true, video_ts: ts });
        return;
      }

      if (msg?.type === "GET_VIDEO_RECT") {
        const v = findVideoElementForCapture(msg.lockedVideoId || null) || getBestVideoElementForRect();
        if (!v) {
          sendResponse({ ok: false, error: "no_video_element" });
          return;
        }
        const r = v.getBoundingClientRect();
        sendResponse({
          ok: true,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          dpr: window.devicePixelRatio || 1,
          video_wh: { w: v.videoWidth || 0, h: v.videoHeight || 0 }
        });
        return;
      }

      if (msg?.type === "GET_PAGE_META") {
        const platform = getPlatform();
        const media = pickBestVisibleMediaEl();

        let title = document.title || "";
        let video_id = null;
        let current_video_id = null;
        let canonical_url = null;
        let player_context = null;
        let video_ts = 0;
        let duration = null;
        let media_type = media?.tagName === "VIDEO" ? "video" : (media?.tagName === "IMG" ? "image" : "unknown");

        if (platform === "youtube") {
          title = getYouTubeTitle();
          const yt = getYouTubeCurrentVideoIdAndContext();
          current_video_id = yt.videoId;
          video_id = yt.videoId;
          player_context = yt.context;
          canonical_url = buildYouTubeCanonicalUrl(yt.videoId, yt.context);
          video_ts = getYouTubeTimestamp();
          const v = getMainVideoEl();
          duration = Number(v?.duration || 0) || null;
        } else if (platform === "tiktok") {
          video_id = getTikTokVideoId();
          current_video_id = video_id;
          canonical_url = location.href;
          video_ts = getVideoTimestamp();
          duration = Number(document.querySelector("video")?.duration || 0) || null;
        } else if (platform === "facebook") {
          const fb = findFacebookPostUrlFromDom();
          video_id = fb.post_id || getFacebookVideoId();
          current_video_id = video_id;
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
            title,
            platform,
            page_url: location.href,
            canonical_url,
            video_id,
            current_video_id,
            player_context,
            video_ts,
            duration,
            media_type,
            captured_at: new Date().toISOString(),
            user_agent: navigator.userAgent,
            viewport: { w: window.innerWidth, h: window.innerHeight }
          }
        });
        return;
      }

      if (msg?.type === "BLOCKLIST_UPDATED") {
        invalidateBlocklistCache();
        checkVideoIdOnPage().catch(() => { });
        scanExisting();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown_message_type" });
    } catch (err) {
      console.warn("[BlocklistGuard] onMessage handler error:", err);
      sendResponse({ ok: false, error: err?.message || "handler_failed" });
    } finally {
      if (!responded) {
        sendResponse({ ok: false, error: "no_response_sent" });
      }
    }
  })();

  return true;
});

(async function initDeepfakeGuard() {
  await loadMonitoringFlag();
  startObserver();
  scanExisting();
  setTimeout(() => { if (!window.__captureInProgress) scanExisting(); }, 1000);
  setTimeout(() => { if (!window.__captureInProgress) scanExisting(); }, 2500);
})();
