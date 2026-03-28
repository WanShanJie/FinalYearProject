// blocked.js — Parses query params and populates the blocked page UI.

(function () {
  const params = new URLSearchParams(location.search);

  const verdict      = params.get("verdict")      || "FAKE";
  const riskScore    = params.get("risk_score")   || "100";
  const title        = params.get("title")        || "";
  const videoId      = params.get("video_id")     || "";
  const originalUrl  = params.get("original_url") || "";
  const referrerUrl  = params.get("referrer_url") || "";

  document.getElementById("videoTitle").textContent = title || "—";
  document.getElementById("videoId").textContent    = videoId || "—";
  document.getElementById("riskScore").textContent  = riskScore + "%";

  const badge = document.getElementById("verdictBadge");
  badge.textContent = verdict;
  badge.className = "badge " + (verdict === "SUSPICIOUS" ? "badge-suspicious" : "badge-fake");

  document.title = `Blocked — ${verdict} Detected`;

  // ── Go Back ────────────────────────────────────────────────────────────────
  // Navigate to wherever the user came from before the blocked video.
  // Falls back to YouTube home if there is no referrer (e.g. direct URL entry).
  document.getElementById("backBtn").addEventListener("click", () => {
    const dest = referrerUrl || "https://www.youtube.com/";
    location.href = dest;
  });

  // ── Proceed anyway ─────────────────────────────────────────────────────────
  // Sends a message to the service worker to open a short bypass window for
  // this video ID, then navigates to the original URL without any extra tokens
  // (YouTube strips unknown query params which would break the bypass).
  const proceedBtn = document.getElementById("proceedBtn");
  if (originalUrl && videoId) {
    proceedBtn.addEventListener("click", async () => {
      const confirmed = confirm(
        "This video has been flagged as a deepfake.\n\nAre you sure you want to proceed?"
      );
      if (!confirmed) return;

      try {
        // Tell the service worker to allow the next navigation for this video ID.
        await chrome.runtime.sendMessage({ type: "ALLOW_BYPASS", videoId });
      } catch { }

      // Navigate to the clean original URL — the SW bypass window is now open.
      location.href = originalUrl;
    });
  } else {
    proceedBtn.style.display = "none";
  }
})();
