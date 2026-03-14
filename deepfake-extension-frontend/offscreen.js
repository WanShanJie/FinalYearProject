// offscreen.js

/**
 * Utility to wait for a specific time
 */
function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Crops a canvas based on a specified rectangle.
 */
function cropCanvasFromRect(sourceCanvas, rect) {
    if (!rect || !rect.w || !rect.h) return sourceCanvas;
    const out = new OffscreenCanvas(Math.max(1, Math.round(rect.w)), Math.max(1, Math.round(rect.h)));
    const ctx = out.getContext("2d", { willReadFrequently: true });

    const sx = Math.max(0, Math.round(rect.x));
    const sy = Math.max(0, Math.round(rect.y));
    const sw = Math.max(1, Math.round(rect.w));
    const sh = Math.max(1, Math.round(rect.h));

    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
}

/**
 * Analyzes frame brightness to detect black/blank frames.
 */
function frameStatsFromCanvas(canvas, sampleStep = 32) {
    const w = Math.max(1, Math.floor(canvas.width / sampleStep));
    const h = Math.max(1, Math.floor(canvas.height / sampleStep));
    const probe = new OffscreenCanvas(w, h);
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
    const avgLuma = sum / total;
    const nonBlackRatio = nonBlack / total;

    return {
        avgLuma,
        nonBlackRatio,
        isMostlyBlack: avgLuma < 6 || nonBlackRatio < 0.02
    };
}

/**
 * Main capture function: Loops audio back to user and extracts frames.
 */
async function captureTabStream({ streamId, frameCount, intervalMs, quality, rect }) {
    console.log("[Offscreen] Initiating capture for stream:", streamId);

    // 1. Capture the tab stream (Audio MUST be true to allow loopback)
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId
            }
        }
    });

    // --- FIX: AUDIO LOOPBACK ---
    // tabCapture hijacks the audio. We pipe it back to an Audio element so the user can hear it.
    const audioSync = new Audio();
    audioSync.srcObject = stream;
    audioSync.play().catch(e => console.error("Audio playback failed:", e));
    // ---------------------------

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true; // Mute the video element itself to prevent double-audio/echo
    await video.play();

    // Ensure video is ready
    await new Promise((resolve) => {
        if (video.readyState >= 2) resolve();
        else video.onloadedmetadata = () => resolve();
    });
    await wait(250);

    const baseCanvas = new OffscreenCanvas(video.videoWidth || 1280, video.videoHeight || 720);
    const ctx = baseCanvas.getContext("2d", { willReadFrequently: true });

    const frames = [];
    const tsMs = [];
    const perFrame = [];
    let blankCount = 0;

    // 2. Extraction Loop (Live Sampling)
    for (let i = 0; i < frameCount; i++) {
        ctx.drawImage(video, 0, 0, baseCanvas.width, baseCanvas.height);
        const cropped = cropCanvasFromRect(baseCanvas, rect);
        const stats = frameStatsFromCanvas(cropped);

        if (!stats.isMostlyBlack) {
            const blob = await cropped.convertToBlob({ type: "image/jpeg", quality: quality || 0.8 });

            // Convert to Base64 using FileReader (more robust than btoa for blobs)
            const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });

            frames.push(base64);
            perFrame.push({ idx: i, ok: true, avgLuma: stats.avgLuma });
        } else {
            blankCount += 1;
            perFrame.push({ idx: i, ok: false, reason: "blank_frame" });
        }

        tsMs.push(Date.now());

        // Wait for the next sampling interval while the video plays naturally
        if (i < frameCount - 1) {
            await wait(Math.max(250, intervalMs || 1000));
        }
    }

    // 3. Cleanup: stop only the VIDEO track.
    // The audio track must stay alive so the loopback (audioSync) keeps playing
    // until Chrome destroys the offscreen document. Stopping the audio track
    // immediately is what cuts the user's sound until they refresh.
    stream.getVideoTracks().forEach(t => t.stop());

    return {
        ok: frames.length > 0,
        frames,
        tsMs,
        videoDimensions: { w: video.videoWidth, h: video.videoHeight },
        debug: { extracted: frames.length, blanks: blankCount, perFrame }
    };
}

/**
 * Unified listener for the Service Worker.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Handling both possible message types for compatibility
    if (msg?.type === "OFFSCREEN_CAPTURE_TAB" || msg?.type === "CAPTURE_TAB_STREAM") {
        captureTabStream(msg)
            .then(sendResponse)
            .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
        return true; // Keep channel open for async response
    }
});