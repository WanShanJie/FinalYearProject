// content.js
// Real-Time Protection: monitors IMG/VIDEO and checks IndexedDB blocklist.
// Analyze feature: provides GET_PAGE_META and EXTRACT_FRAMES_LIVE.

if (!window.__deepfakeGuardInstalled) {
  window.__deepfakeGuardInstalled = true;
  (function() {

// ── Performance timing (content script side) ──────────────────────────────────
// Lightweight logger — writes to chrome.storage.local so the popup can read it.
// Keeps only the last 50 entries to avoid unbounded storage growth.
var _contextDead = false;
var _perfLog = [];
var _perfFlushTimer = null;

function perfMark(metric, valueMs, extra = {}) {
  const entry = { metric, ms: Math.round(valueMs), ts: Date.now(), ...extra };
  _perfLog.push(entry);
  console.log(`[Perf][${metric}] ${entry.ms}ms`, extra);
  // Debounce writes — flush at most once every 500 ms
  if (!_perfFlushTimer) {
    if (_contextDead) return;
    _perfFlushTimer = setTimeout(() => {
      _perfFlushTimer = null;
      if (_contextDead || !chrome.runtime?.id) {
        _contextDead = true;
        _perfLog = [];
        return;
      }
      chrome.storage.local.get(["perfLog"], st => {
        if (chrome.runtime.lastError) {
          if ((chrome.runtime.lastError.message || "").includes("context invalidated")) _contextDead = true;
          return;
        }
        const existing = Array.isArray(st.perfLog) ? st.perfLog : [];
        const merged = [...existing, ..._perfLog].slice(-100);
        _perfLog = [];
        chrome.storage.local.set({ perfLog: merged });
      });
    }, 500);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── SINGLE-INSTANCE GUARD ────────────────────────────────────────────────────
// Prevents duplicate listeners if the script is injected more than once.
// Uses a plain window property — never const/let at top level, which would
// throw "already declared" on re-injection in the same page context.
// ─────────────────────────────────────────────────────────────────────────────

var monitoringEnabled = false;
var observerStarted = false;
var currentUrl = location.href;

// Set to true while EXTRACT_FRAMES_LIVE is running so scanning/blocking
// callbacks don't fire concurrently and interfere with frame capture.
window.__captureInProgress = false;

// ── Safe SW messaging ─────────────────────────────────────────────────────────

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
  if (_scannedMedia.has(el)) return;
  _scannedMedia.add(el);
  try {
    const hash = await fingerprintElement(el);
    if (!hash) return;
    await bumpCounter("scanned", 1);

    // ── Metric: blocklist_check_latency ───────────────────────────────────────
    const t0Check = performance.now();
    const res = await safeSendMessage({ type: "CHECK_FINGERPRINT_BLOCKLIST", hash });
    perfMark("blocklist_check_latency", performance.now() - t0Check,
      { hit: !!(res?.ok && res?.entry), type: "fingerprint" });
    // ─────────────────────────────────────────────────────────────────────────

    if (res?.ok && res?.entry) {
      // ── Metric: ui_block_latency ────────────────────────────────────────────
      const t0Block = performance.now();
      blockElement(el, res.entry);
      perfMark("ui_block_latency", performance.now() - t0Block, { type: "overlay" });
      // ───────────────────────────────────────────────────────────────────────
      await bumpCounter("blocked", 1);
    }
    safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
  } catch { }
}

// ── Video ID page check ───────────────────────────────────────────────────────

var _videoIdCache = new Map();

/**
 * Show a dismissible warning banner above the YouTube player on the watch page.
 * The video is NOT paused — user can still watch.
 */
function addWatchPageWarning(entry) {
  if (document.querySelector("[data-df-watch-warning]")) return;

  const risk = entry?.risk_score != null ? `${entry.risk_score}%` : null;
  const title = entry?.title ? `"${entry.title.slice(0, 70)}${entry.title.length > 70 ? "…" : ""}"` : null;

  const banner = document.createElement("div");
  banner.dataset.dfWatchWarning = "1";
  banner.style.cssText = [
    "width:100%",
    "box-sizing:border-box",
    "background:linear-gradient(135deg,#1c0000 0%,#3b0000 100%)",
    "border:2px solid #ef4444",
    "border-radius:10px",
    "padding:14px 16px",
    "margin-bottom:12px",
    "display:flex",
    "align-items:flex-start",
    "gap:12px",
    "font-family:system-ui,sans-serif",
    "z-index:9999",
    "position:relative",
    "box-shadow:0 0 0 1px rgba(239,68,68,0.3),0 4px 20px rgba(239,68,68,0.25)",
  ].join(";");

  const iconEl = document.createElement("div");
  iconEl.textContent = "⚠️";
  iconEl.style.cssText = "font-size:2rem;flex-shrink:0;line-height:1;margin-top:2px;";

  const textWrap = document.createElement("div");
  textWrap.style.cssText = "flex:1;min-width:0;";

  const headline = document.createElement("div");
  headline.style.cssText = [
    "color:#ef4444",
    "font-weight:900",
    "font-size:1rem",
    "margin-bottom:4px",
    "letter-spacing:0.03em",
    "text-transform:uppercase",
  ].join(";");
  headline.textContent = "⚠ Suspected AI Deepfake" + (risk ? `  ·  Risk Score: ${risk}` : "");

  const sub = document.createElement("div");
  sub.style.cssText = [
    "color:#fca5a5",
    "font-size:0.82rem",
    "line-height:1.5",
    "margin-bottom:8px",
  ].join(";");
  sub.textContent = title
    ? `${title} has been flagged as a potential deepfake by the A2U Deepfake Detection system. You can still watch, but please review this content critically.`
    : "This video has been flagged as a potential deepfake by the A2U Deepfake Detection system. You can still watch, but please review this content critically.";

  const detailRow = document.createElement("div");
  detailRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

  const pill = document.createElement("span");
  pill.style.cssText = [
    "background:rgba(239,68,68,0.15)",
    "border:1px solid rgba(239,68,68,0.4)",
    "color:#fca5a5",
    "font-size:0.72rem",
    "font-weight:700",
    "padding:2px 8px",
    "border-radius:999px",
    "letter-spacing:0.04em",
    "text-transform:uppercase",
  ].join(";");
  pill.textContent = "AI DETECTION ALERT";

  const portal = document.createElement("span");
  portal.style.cssText = "color:rgba(255,255,255,0.4);font-size:0.72rem;";
  portal.textContent = "View full analysis in the A2U portal →";

  detailRow.append(pill, portal);
  textWrap.append(headline, sub, detailRow);

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "✕";
  dismissBtn.title = "Dismiss";
  dismissBtn.style.cssText = [
    "background:rgba(255,255,255,0.08)",
    "border:1px solid rgba(255,255,255,0.2)",
    "color:rgba(255,255,255,0.6)",
    "font-size:0.9rem",
    "cursor:pointer",
    "padding:4px 8px",
    "border-radius:6px",
    "line-height:1",
    "flex-shrink:0",
    "margin-top:2px",
  ].join(";");
  dismissBtn.addEventListener("click", () => banner.remove());

  banner.append(iconEl, textWrap, dismissBtn);

  // Insert above the player — try several known YouTube DOM anchors
  const insertTargets = [
    () => document.querySelector("#above-the-fold"),
    () => document.querySelector("ytd-watch-flexy #columns #primary"),
    () => document.querySelector("#primary-inner"),
    () => document.querySelector("#player-container"),
    () => document.querySelector("ytd-watch-flexy"),
  ];
  for (const fn of insertTargets) {
    const el = fn();
    if (el) { el.insertBefore(banner, el.firstChild); return; }
  }
  // Fallback: prepend to body
  document.body.insertBefore(banner, document.body.firstChild);
}

async function checkVideoIdOnPage() {
  if (window.__captureInProgress) return;
  if (!monitoringEnabled) return;
  try {
    // ── Metric: watch_page_to_blocked_covered ──────────────────────────────
    const t0Watch = performance.now();
    // ─────────────────────────────────────────────────────────────────────

    const url = location.href;
    let videoId = null;
    const shorts = url.match(/\/shorts\/([^/?]+)/);
    if (shorts) videoId = shorts[1];
    else { try { videoId = new URL(url).searchParams.get("v"); } catch { } }
    if (!videoId) return;

    if (_videoIdCache.has(videoId)) {
      const cached = _videoIdCache.get(videoId);
      if (cached) {
        addWatchPageWarning(cached);
        perfMark("watch_page_to_blocked_covered", performance.now() - t0Watch,
          { videoId, source: "cache", hit: true });
      }
      return;
    }

    const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
    _videoIdCache.set(videoId, res?.ok && res?.entry ? res.entry : null);
    if (res?.ok && res?.entry) {
      addWatchPageWarning(res.entry);
      // ── Metric end ───────────────────────────────────────────────────────
      perfMark("watch_page_to_blocked_covered", performance.now() - t0Watch,
        { videoId, source: "idb_lookup", hit: true });
      // ─────────────────────────────────────────────────────────────────────
      await bumpCounter("blocked", 1);
      safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
    } else {
      // No block — still log the check latency for the "clean" path
      perfMark("watch_page_to_blocked_covered", performance.now() - t0Watch,
        { videoId, source: "idb_lookup", hit: false });
    }
  } catch { }
}

// ── YouTube card scanning (Layer A: exact video_id only) ──────────────────────

var YT_CARD_SELECTORS = [
  "ytd-rich-item-renderer",          // Home feed grid card
  "ytd-video-renderer",              // History, search results, playlists list
  "ytd-grid-video-renderer",         // Channel page grid, playlists grid
  "ytd-compact-video-renderer",      // Sidebar "Up next" / related videos
  "ytd-reel-item-renderer",          // Shorts shelf item
  "ytd-rich-grid-slim-media",        // Shorts shelf grid cell
  "ytd-playlist-video-renderer",     // Watch Later, playlist detail page
  "ytd-playlist-panel-video-renderer", // Playlist panel (side queue)
  "yt-lockup-view-model",            // New YouTube UI card format
].join(", ");

var _scannedCards = new WeakSet();
var _scannedMedia = new WeakSet();

function extractCardVideoId(card) {
  // New YouTube UI lockup model stores video ID in a data attribute
  const lockupId = card.getAttribute("data-video-id") || card.querySelector("[data-video-id]")?.getAttribute("data-video-id");
  if (lockupId) return lockupId;

  // Playlist panel video renderer has a different attribute
  const panelId = card.getAttribute("video-id");
  if (panelId) return panelId;

  // Standard anchor href extraction for all other card types
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

function getYouTubeThumbnailHost(card) {
  const candidates = [
    card.querySelector("a#thumbnail"),
    card.querySelector("a[href*='/watch'] ytd-thumbnail"),
    card.querySelector("a[href*='/shorts/'] ytd-thumbnail"),
    card.querySelector("ytd-thumbnail"),
    card.querySelector("#thumbnail"),
    card.querySelector("yt-image"),
    card.querySelector("[id='thumbnail']"),
  ].filter(Boolean);

  const cardRect = card.getBoundingClientRect();
  const maxReasonableWidth = cardRect.width ? Math.max(320, cardRect.width * 0.9) : 520;

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width >= 120 && rect.height >= 68 && rect.width <= maxReasonableWidth) {
      return el;
    }
  }

  return candidates[0] || card;
}

/**
 * Attach a bold, unmissable warning overlay to a flagged card thumbnail.
 * Covers the thumbnail with a dimmed overlay + red border + large warning.
 * Card link is still fully clickable via "Watch anyway" button.
 */
function addWarningBadge(card, entry) {
  if (card.querySelector("[data-df-warning]")) return;

  const thumbHost = getYouTubeThumbnailHost(card);

  if (getComputedStyle(thumbHost).position === "static") {
    thumbHost.style.setProperty("position", "relative", "important");
  }
  thumbHost.style.setProperty("overflow", "hidden", "important");

  const risk = entry?.risk_score != null ? `${entry.risk_score}%` : null;

  // Extract the video link so "Watch anyway" can navigate
  const videoLink = card.querySelector("a[href*='/watch'], a[href*='/shorts/']");
  const href = videoLink?.getAttribute("href") || null;

  // Full-thumbnail overlay — dims the image and draws attention
  const overlay = document.createElement("div");
  overlay.dataset.dfWarning = "1";
  overlay.style.cssText = [
    "position:absolute",
    "inset:0",
    "z-index:20",
    "background:rgba(10,0,0,0.78)",
    "border:3px solid #ef4444",
    "border-radius:inherit",
    "box-sizing:border-box",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:4px",
    "padding:8px",
    "cursor:default",
    "pointer-events:auto",
  ].join(";");

  // Stop card link from firing when clicking the overlay itself
  overlay.addEventListener("click", e => e.stopPropagation());

  // Warning icon
  const iconEl = document.createElement("div");
  iconEl.textContent = "⚠️";
  iconEl.style.cssText = "font-size:1.6rem;line-height:1;";

  // "AI DEEPFAKE" label
  const labelEl = document.createElement("div");
  labelEl.style.cssText = [
    "color:#ef4444",
    "font-weight:900",
    "font-size:0.78rem",
    "font-family:system-ui,sans-serif",
    "letter-spacing:0.08em",
    "text-transform:uppercase",
    "text-align:center",
    "text-shadow:0 1px 4px rgba(0,0,0,0.8)",
    "line-height:1.2",
  ].join(";");
  labelEl.textContent = risk ? `Deepfake · ${risk} risk` : "Suspected Deepfake";

  // Button row
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px;";

  // Watch anyway button
  if (href) {
    const watchBtn = document.createElement("a");
    watchBtn.href = href;
    watchBtn.textContent = "Watch anyway";
    watchBtn.style.cssText = [
      "background:rgba(255,255,255,0.15)",
      "border:1px solid rgba(255,255,255,0.4)",
      "color:#fff",
      "font-size:0.62rem",
      "font-family:system-ui,sans-serif",
      "font-weight:600",
      "padding:3px 7px",
      "border-radius:3px",
      "cursor:pointer",
      "text-decoration:none",
      "white-space:nowrap",
      "line-height:1.4",
    ].join(";");
    watchBtn.addEventListener("click", e => e.stopPropagation());
    btnRow.appendChild(watchBtn);
  }

  // Dismiss button
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "✕";
  dismissBtn.title = "Dismiss";
  dismissBtn.style.cssText = [
    "background:rgba(255,255,255,0.1)",
    "border:1px solid rgba(255,255,255,0.3)",
    "color:rgba(255,255,255,0.8)",
    "font-size:0.62rem",
    "font-family:system-ui,sans-serif",
    "padding:3px 6px",
    "border-radius:3px",
    "cursor:pointer",
    "line-height:1.4",
  ].join(";");
  dismissBtn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    overlay.remove();
    if (thumbHost.dataset.dfThumbGlow) {
      thumbHost.style.boxShadow = "";
      delete thumbHost.dataset.dfThumbGlow;
    }
  });
  btnRow.appendChild(dismissBtn);

  overlay.append(iconEl, labelEl, btnRow);
  thumbHost.appendChild(overlay);

  thumbHost.style.boxShadow = "0 0 0 2px #ef4444 inset";
  thumbHost.dataset.dfThumbGlow = "1";
}

async function processYouTubeCard(card) {
  if (window.__captureInProgress) return;
  if (_scannedCards.has(card)) return;

  // ── Metric: dom_detection_latency ─────────────────────────────────────────
  // Time from card appearing in DOM (MutationObserver fires) → we start processing.
  // We approximate DOM insertion time with performance.now() at entry, which is
  // called directly from the MutationObserver callback with minimal delay.
  const t0Dom = performance.now();
  _scannedCards.add(card);

  const videoId = extractCardVideoId(card);
  if (!videoId) return;
  perfMark("dom_detection_latency", performance.now() - t0Dom, { type: "card_video_id" });
  // ──────────────────────────────────────────────────────────────────────────

  // Cache hit — no IPC needed
  if (_videoIdCache.has(videoId)) {
    const entry = _videoIdCache.get(videoId);
    if (entry) {
      const t0UI = performance.now();
      addWarningBadge(card, entry);
      perfMark("ui_block_latency", performance.now() - t0UI, { type: "badge_cached" });
    }
    return;
  }

  // ── Metric: blocklist_check_latency ───────────────────────────────────────
  const t0Check = performance.now();
  const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
  perfMark("blocklist_check_latency", performance.now() - t0Check,
    { hit: !!(res?.ok && res?.entry), type: "video_id" });
  // ──────────────────────────────────────────────────────────────────────────

  const entry = res?.ok && res?.entry ? res.entry : null;
  _videoIdCache.set(videoId, entry);

  if (entry) {
    const t0UI = performance.now();
    addWarningBadge(card, entry);
    perfMark("ui_block_latency", performance.now() - t0UI, { type: "badge_fresh" });
    bumpCounter("blocked", 1).catch(() => { });
    safeSendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
  }
}

function scanYouTubeCards(root = document) {
  if (window.__captureInProgress) return;
  if (!monitoringEnabled) return;
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

// YouTube fires "yt-navigate-finish" on every SPA page transition.
// This is more reliable than watching addedNodes for URL changes.
window.addEventListener("yt-navigate-finish", () => {
  if (location.href === currentUrl) return;
  // ── Metric: spa_navigate_to_extension_active ───────────────────────────────
  // Fires on every YouTube SPA navigation (search → watch, watch → watch, etc.).
  // Records how long after the navigation event the extension resets + rescans.
  const t0Nav = performance.now();
  // ──────────────────────────────────────────────────────────────────────────
  currentUrl = location.href;
  _videoIdCache.clear();
  _scannedCards = new WeakSet();
  _scannedMedia = new WeakSet();
  document.querySelectorAll("[data-df-warning]").forEach(el => el.remove());
  document.querySelectorAll("[data-df-watch-warning]").forEach(el => el.remove());
  clearTimeout(scanTimer);
  // History/Playlist pages render content lazily — wait 800ms before first scan,
  // then scan again at 2s in case more cards loaded.
  scanTimer = setTimeout(() => {
    perfMark("spa_navigate_to_extension_active", performance.now() - t0Nav, {
      platform: "youtube",
      url: location.href.slice(0, 80),
    });
    checkVideoIdOnPage().catch(() => { });
    scanYouTubeCards(document);
    setTimeout(() => scanYouTubeCards(document), 1500);
  }, 800);
});

var mo = new MutationObserver((mutations) => {
  if (window.__captureInProgress) return;

  // Always check for SPA navigation FIRST — YouTube sometimes pushes a URL
  // change via history.pushState without immediately adding nodes, so checking
  // addedNodes first would cause us to miss the navigation entirely.
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    _videoIdCache.clear();
    _scannedCards = new WeakSet();
    _scannedMedia = new WeakSet();
    document.querySelectorAll("[data-df-warning]").forEach(el => el.remove());
    document.querySelectorAll("[data-df-watch-warning]").forEach(el => el.remove());
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      checkVideoIdOnPage().catch(() => { });
      scanYouTubeCards(document);
      setTimeout(() => scanYouTubeCards(document), 1500);
    }, 800);
    return;
  }

  // Scan when new nodes appear (lazy-loaded cards, infinite scroll)
  let hasAdded = false;
  // ── Metric: scroll_inject_to_card_scanned ─────────────────────────────────
  // Record timestamp when MutationObserver fires (= when browser tells us
  // new nodes exist). The scan happens after the 300ms debounce — we store
  // the observer fire time and measure in the scan callback.
  let mutationFireTime = null;
  for (const m of mutations) {
    if (m.addedNodes.length > 0) { hasAdded = true; mutationFireTime = performance.now(); break; }
  }
  if (!hasAdded) return;

  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    const scanStart = performance.now();
    scanYouTubeCards(document);
    // Time from observer fire → scan function called (includes 300ms debounce)
    if (mutationFireTime !== null) {
      perfMark("scroll_inject_to_card_scanned", performance.now() - mutationFireTime, {
        debounce_ms: 300,
        scan_ms: Math.round(performance.now() - scanStart),
        platform: getPlatform(),
      });
    }
  }, 300);
  // ──────────────────────────────────────────────────────────────────────────
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

  // Enforce 250ms minimum so the video decoder has time to advance between frames.
  // At 100ms consecutive captures often share the same currentTime; the opencv
  // pipeline's duplicate-frame filter discards them and the quality gate fails.
  intervalMs = Math.max(250, intervalMs);

  // Verify the locked video element is ready WITHOUT swapping it for a different
  // element. Calling waitForVideoReady() here would block for up to 12s and might
  // return a different video node — instead we check the element we already have.
  if (!(video.videoWidth > 0 && video.readyState >= 2)) {
    // Give the player a short window to become ready before giving up.
    const readyStart = Date.now();
    while (Date.now() - readyStart < 5000) {
      await wait(150);
      if (video.videoWidth > 0 && video.readyState >= 2) break;
    }
    if (!(video.videoWidth > 0 && video.readyState >= 2)) {
      return { ok: false, error: "video_not_ready" };
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // ── Audio recording from the video element (for Wav2Lip) ──────────────────
  // captureStream() gives us the raw audio from the YouTube player without
  // needing tabCapture or any extra permissions.
  let audioRecorder = null;
  const audioChunks = [];
  const audioDebug = {
    captureStreamSupported: typeof video.captureStream === "function",
    audioTrackCount: 0,
    recorderStarted: false,
    recorderMimeType: null,
    chunkCount: 0,
    blobSize: 0,
    error: null,
  };
  try {
    const stream = video.captureStream ? video.captureStream() : null;
    const audioTracks = stream ? stream.getAudioTracks() : [];
    audioDebug.audioTrackCount = audioTracks.length;
    console.log("[Capture][Audio] captureStream info:", {
      supported: audioDebug.captureStreamSupported,
      audioTracks: audioTracks.length,
      videoTracks: stream ? stream.getVideoTracks().length : 0,
      paused: video.paused,
      muted: video.muted,
      readyState: video.readyState,
      currentTime: Number(video.currentTime || 0),
    });
    if (audioTracks.length > 0) {
      const audioStream = new MediaStream(audioTracks);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      audioDebug.recorderMimeType = mimeType;
      audioRecorder = new MediaRecorder(audioStream, { mimeType });
      audioRecorder.ondataavailable = e => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
          audioDebug.chunkCount += 1;
          console.log("[Capture][Audio] chunk:", e.data.size);
        }
      };
      audioRecorder.onerror = e => {
        audioDebug.error = e?.error?.message || "media_recorder_error";
        console.warn("[Capture][Audio] recorder error:", e);
      };
      audioRecorder.start();
      audioDebug.recorderStarted = true;
      console.log("[Capture][Audio] recorder started with mime:", mimeType);
    } else {
      audioDebug.error = "no_audio_tracks_from_video_element";
      console.warn("[Capture][Audio] No audio tracks were exposed by video.captureStream().");
    }
  } catch (e) {
    console.warn("[Capture] Audio recorder start failed:", e);
    audioDebug.error = e?.message || String(e);
    audioRecorder = null;
  }
  // ──────────────────────────────────────────────────────────────────────────

  const startedAt = Date.now();
  const frames = [], tsMs = [], perFrame = [];
  let blankCount = 0;

  await wait(Math.max(0, Number(warmupMs || 0)));
  await waitForPresentedVideoFrame(video, 1200);

  for (let i = 0; i < frameCount; i++) {
    const capture = await waitUntilNotMostlyBlack(video, canvas, ctx, 2200, quality);
    const currentTsMs = Math.round(Number(video.currentTime || 0) * 1000);

    if (capture.ok) {
      frames.push(capture.dataUrl);
      tsMs.push(currentTsMs);
      perFrame.push({
        idx: i, tsMs: currentTsMs, ok: true,
        avgLuma: capture.stats.avgLuma,
        nonBlackRatio: capture.stats.nonBlackRatio,
      });
      console.log(`[Capture] frame ${i} at ${currentTsMs}ms`);
    } else {
      blankCount++;
      perFrame.push({
        idx: i, tsMs: currentTsMs, ok: false, reason: "blank_frame",
        avgLuma: capture.stats?.avgLuma ?? 0,
        nonBlackRatio: capture.stats?.nonBlackRatio ?? 0,
      });
      console.warn(`[Capture] frame ${i} blank`);
    }

    if (i < frameCount - 1) {
      // Wait for a genuinely new decoded frame — not a fixed timer.
      const loopStart = Date.now();
      while (Date.now() - loopStart < intervalMs) {
        await waitForPresentedVideoFrame(video, Math.min(600, intervalMs));
      }
    }
  }

  console.log("[Capture] extraction done:", {
    requested: frameCount, captured: frames.length, blankCount,
    elapsedMs: Date.now() - startedAt,
  });

  // ── Stop audio recorder and collect blob ──────────────────────────────────
  let audioB64 = null;
  if (audioRecorder && audioRecorder.state !== "inactive") {
    try {
      await new Promise(resolve => {
        audioRecorder.onstop = resolve;
        audioRecorder.stop();
      });
      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        audioDebug.blobSize = audioBlob.size;
        audioB64 = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(audioBlob);
        });
        console.log("[Capture] Audio recorded, size:", audioBlob.size, "bytes");
      } else {
        audioDebug.error = audioDebug.error || "audio_blob_empty";
        console.warn("[Capture][Audio] Recorder stopped but produced no audio chunks.");
      }
    } catch (e) {
      console.warn("[Capture] Audio recorder stop failed:", e);
      audioDebug.error = e?.message || String(e);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  return {
    ok: frames.length > 0, frames, tsMs,
    audioB64,
    w: canvas.width, h: canvas.height,
    debug: {
      extractedCount: frames.length,
      blankCount,
      totalRequested: frameCount,
      perFrame,
      source: "dom_canvas_live",
      nonBlocking: true,
      elapsedMs: Date.now() - startedAt,
      hasAudio: !!audioB64,
      audio: audioDebug,
    },
    error: frames.length > 0 ? null : "all_frames_blank_or_failed",
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

      // ── Metric: capture_latency (content-script side) ─────────────────────
      const t0Capture = performance.now();
      // ─────────────────────────────────────────────────────────────────────

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

        // ── Metric: capture_latency ──────────────────────────────────────────
        perfMark("capture_latency", performance.now() - t0Capture, {
          frames: out.frames?.length ?? 0,
          blank: out.debug?.blankCount ?? 0,
          ok: out.ok,
          source: "content_canvas",
        });
        // ────────────────────────────────────────────────────────────────────

        sendResponse(out);
      } catch (err) {
        console.error("[Capture] EXTRACT_FRAMES_LIVE error:", err);
        perfMark("capture_latency", performance.now() - t0Capture, { ok: false, error: err?.message });
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
      _scannedMedia = new WeakSet();
      if (!window.__captureInProgress) {
        checkVideoIdOnPage().catch(() => { });
        scanExisting();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "GET_PORTAL_USER") {
      // Called by the extension popup/SW to determine which portal account is
      // active in this tab, enabling per-user token isolation.
      try {
        const raw = localStorage.getItem("token");
        if (!raw) { sendResponse({ ok: false }); return; }
        const payload = JSON.parse(atob(raw.split(".")[1]));
        sendResponse({ ok: true, userId: String(payload.sub), email: payload.email || null });
      } catch { sendResponse({ ok: false }); }
      return;
    }

    sendResponse({ ok: false, error: "unknown_message_type" });
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "EXTENSION_LINK_UPDATED") {
    window.postMessage({ type: "A2U_EXTENSION_STATUS_CHANGED" }, "*");
  }
});

// ── Bridge between Web Portal (Settings.jsx) and Extension ──────────────────
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === "A2U_PORTAL_REVOKED") {
    try {
      const raw = localStorage.getItem("token");
      const payload = raw ? JSON.parse(atob(raw.split(".")[1])) : null;
      safeSendMessage({ type: "DISCONNECT_EXTENSION", userId: payload ? String(payload.sub) : null });
    } catch {
      safeSendMessage({ type: "DISCONNECT_EXTENSION" });
    }
  }
  
  if (data.type === "A2U_PORTAL_CONNECT") {
    safeSendMessage({ type: "PORTAL_INITIATE_CONNECT" });
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  // ── Metric: page_load_to_extension_active ──────────────────────────────────
  // performance.timeOrigin is the navigation start time.
  // performance.now() here is how long since page navigation began.
  // Together they give: time from page load → content script active.
  const pageLoadAge = performance.now();
  perfMark("page_load_to_extension_active", pageLoadAge, {
    platform: getPlatform(),
    url: location.href.slice(0, 80),
  });
  // ──────────────────────────────────────────────────────────────────────────

  await loadMonitoringFlag();
  startObserver();
  // Initial scans — staggered because History/Playlist pages load cards lazily
  setTimeout(() => { if (!window.__captureInProgress) scanExisting(); }, 800);
  setTimeout(() => { if (!window.__captureInProgress) scanYouTubeCards(document); }, 2000);
  setTimeout(() => { if (!window.__captureInProgress) { checkVideoIdOnPage().catch(() => { }); scanYouTubeCards(document); } }, 4000);
})();

// ── Metric: play_event_to_extension_response ──────────────────────────────────
// Attach once at document level (capture phase) so we catch play events from
// any video element regardless of when it was inserted into the DOM.
// Measures: user presses play → extension reacts (video-ID blocklist check).
document.addEventListener("play", async (e) => {
  if (window.__captureInProgress) return;
  const video = e.target;
  if (!video || video.tagName !== "VIDEO") return;
  if (!location.hostname.includes("youtube.com")) return;

  const t0Play = performance.now();
  const yt = getYouTubeCurrentVideoIdAndContext();
  const videoId = yt.videoId;
  if (!videoId) return;

  const res = await safeSendMessage({ type: "CHECK_VIDEO_ID_BLOCKLIST", videoId });
  const ms = performance.now() - t0Play;
  perfMark("play_event_to_extension_response", ms, {
    videoId,
    hit: !!(res?.ok && res?.entry),
    platform: "youtube",
  });
}, true /* capture phase — fires before the video actually starts */);
// ─────────────────────────────────────────────────────────────────────────────
  })();
} else {
  console.log("[DeepfakeGuard] Already active in this tab.");
}
