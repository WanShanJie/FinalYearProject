// content.js
// Real-Time Protection: monitors IMG/VIDEO and checks local IndexedDB blocklist using a demo aHash.
// Analyze feature: provides GET_PAGE_META metadata and supports PREP_CAPTURE / WAIT_UNTIL_READY / SEEK_TO.

let monitoringEnabled = false;
let observerStarted = false;

async function loadMonitoringFlag() {
  const st = await chrome.storage.local.get(["monitoringEnabled"]);
  monitoringEnabled = st.monitoringEnabled === true;
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

function frameStatsFromCanvas(canvas, sampleStep = 32) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const w = Math.max(1, Math.floor(width / sampleStep));
  const h = Math.max(1, Math.floor(height / sampleStep));
  const probe = document.createElement("canvas");
  probe.width = w;
  probe.height = h;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(canvas, 0, 0, w, h);
  const data = pctx.getImageData(0, 0, w, h).data;

  let sum = 0;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    sum += lum;
    if (lum > 8) nonBlack += 1;
  }
  const total = Math.max(1, data.length / 4);
  return {
    avgLuma: sum / total,
    nonBlackRatio: nonBlack / total,
    isMostlyBlack: (sum / total) < 6 || (nonBlack / total) < 0.02,
  };
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
  if (!monitoringEnabled) return;
  try {
    const hash = await fingerprintElement(el);
    if (!hash) return;

    await bumpCounter("scanned", 1);

    const matched = await self.DeepfakeIDB.idbHas(hash);
    if (matched) {
      markMatched(el);
      await bumpCounter("blocked", 1);
    }

    chrome.runtime.sendMessage({ type: "COUNTS_UPDATED" }).catch(() => { });
  } catch {
    // canvas/CORS issues; skip
  }
}

function scanExisting() {
  document.querySelectorAll("img, video").forEach(processMedia);
}

const mo = new MutationObserver((mutations) => {
  if (!monitoringEnabled) return;
  for (const m of mutations) {
    for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (isMediaEl(n)) processMedia(n);
      n.querySelectorAll?.("img, video")?.forEach(processMedia);
    }
  }
});

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

function getBestVideoElementForRect() {
  const shortsActive =
    document.querySelector('ytd-reel-video-renderer[is-active] video') ||
    document.querySelector('ytd-reel-video-renderer[is-active]')?.querySelector("video");
  if (shortsActive) return shortsActive;

  const main = document.querySelector("video.html5-main-video");
  if (main) return main;

  const vids = Array.from(document.querySelectorAll("video"))
    .filter(v => v.offsetParent !== null);
  vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  return vids[0] || null;
}

/**
 * Returns the best video element to use as the capture source.
 * For Shorts: locks onto the currently-active reel element at capture-start time.
 * Keeping a reference to this specific element means drawImage() keeps working
 * even if the user scrolls to a different Short mid-capture.
 */
function findVideoElementForCapture(lockedVideoId) {
  const isShorts = location.pathname.includes('/shorts/');

  if (isShorts) {
    // Primary: the active reel renderer's <video>
    const active =
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('ytd-reel-video-renderer[is-active]')?.querySelector('video');
    if (active) return active;

    // Fallback: any Shorts video visible on screen
    const any = document.querySelector('ytd-reel-video-renderer video');
    if (any) return any;
  }

  // Standard watch page or any other context
  return getBestVideoElementForRect() || getMainVideoEl();
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

async function waitForVideoReady(timeoutMs = 12000, lockedVideoId = null) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const v = findVideoElementForCapture(lockedVideoId) || getMainVideoEl();

    if (v) {
      const hasMetadata = v.videoWidth > 0 && v.videoHeight > 0;
      const hasFrameData = v.readyState >= 2;

      // For Shorts, metadata may appear a bit earlier than full "ready"
      if (hasMetadata) {
        await waitForPresentedVideoFrame(v, 800);

        if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) {
          return {
            ok: true,
            ready: true,
            w: v.videoWidth,
            h: v.videoHeight,
            ts: Number(v.currentTime || 0)
          };
        }
      }

      // Retry quickly for Shorts while the reel is attaching / activating
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
    } catch {
      await wait(120);
      continue;
    }

    const stats = frameStatsFromCanvas(canvas);
    lastStats = stats;

    if (!stats.isMostlyBlack) {
      return {
        ok: true,
        stats,
        dataUrl: canvas.toDataURL("image/jpeg", quality)
      };
    }

    await waitForPresentedVideoFrame(video, 600);
  }

  return { ok: false, stats: lastStats };
}

async function extractLiveFramesFromVideo(video, {
  frameCount = 8,
  intervalMs = 1000,
  quality = 0.8,
  warmupMs = 350
} = {}) {
  if (!video) return { ok: false, error: "no_video_element" };

  const ready = await waitForVideoReady(12000);
  if (!ready.ok) return { ok: false, error: ready.error || "not_ready" };

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const startedAt = Date.now();
  const frames = [];
  const tsMs = [];
  const perFrame = [];
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
        idx: i,
        tsMs: currentTsMs,
        ok: true,
        avgLuma: capture.stats.avgLuma,
        nonBlackRatio: capture.stats.nonBlackRatio
      });
    } else {
      blankCount += 1;
      perFrame.push({
        idx: i,
        tsMs: currentTsMs,
        ok: false,
        reason: "blank_frame",
        avgLuma: capture.stats?.avgLuma ?? 0,
        nonBlackRatio: capture.stats?.nonBlackRatio ?? 0
      });
    }

    if (i < frameCount - 1) {
      const loopStart = Date.now();
      while (Date.now() - loopStart < intervalMs) {
        await waitForPresentedVideoFrame(video, Math.min(600, intervalMs));
      }
    }
  }

  return {
    ok: frames.length > 0,
    frames,
    tsMs,
    w: canvas.width,
    h: canvas.height,
    debug: {
      extractedCount: frames.length,
      blankCount,
      totalRequested: frameCount,
      perFrame,
      source: "dom_canvas_live",
      nonBlocking: true,
      elapsedMs: Date.now() - startedAt
    },
    error: frames.length > 0 ? null : "all_frames_blank_or_failed"
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "WAIT_UNTIL_READY") {
      const res = await waitForVideoReady(
        Number(msg.timeoutMs || 12000),
        msg.lockedVideoId || null
      );
      sendResponse(res);
      return;
    }

    if (msg?.type === "PREP_CAPTURE") {
      const res = await waitForVideoReady(12000, msg.lockedVideoId || null);
      sendResponse(res.ok ? { ok: true, ...res } : res);
      return;
    }

    if (msg?.type === "EXTRACT_FRAMES_LIVE") {
      // Lock onto the video element NOW before any async work.
      // For Shorts: this reference stays valid even if the user scrolls to a new reel.
      const v = findVideoElementForCapture(msg.lockedVideoId);
      if (!v) {
        sendResponse({ ok: false, error: "no_video_element" });
        return;
      }

      const frameCount = Number(msg.frameCount || 8);
      const intervalMs = Number(msg.intervalMs || 1000);
      const quality = Number(msg.quality || 0.8);
      const warmupMs = Number(msg.warmupMs || 350);

      const out = await extractLiveFramesFromVideo(v, {
        frameCount,
        intervalMs: Math.max(250, intervalMs),
        quality,
        warmupMs
      });
      sendResponse(out);
      return;
    }

    if (msg?.type === "SET_MONITORING") {
      monitoringEnabled = !!msg.enabled;
      await chrome.storage.local.set({ monitoringEnabled });
      if (monitoringEnabled) startObserver();
      else stopObserver();
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
      const v = getBestVideoElementForRect();
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
  })();

  return true;
});
