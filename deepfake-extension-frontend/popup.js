// popup.js — UI logic
// - Real-Time Protection toggle persists in chrome.storage.local as "monitoringEnabled"
// - Analyze button always works, triggers service worker capture+send
const DASHBOARD_URL = "http://localhost:5173/dashboard"; // TODO: change to your real URL

const toggle = document.getElementById("toggleMonitoring");
const scannedCount = document.getElementById("scannedCount");
const blockedCount = document.getElementById("blockedCount");
const fpTitle = document.getElementById("fpTitle");
const fpSub = document.getElementById("fpSub");
const btnAnalyzeNow = document.getElementById("btnAnalyzeNow");
const analyzeMsg = document.getElementById("analyzeMsg");
const openDashboard = document.getElementById("openDashboard");

async function sendToActiveTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false };
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch { return { ok: false }; }
}

async function refreshUI() {
  const st = await chrome.storage.local.get(["scanned", "blocked", "monitoringEnabled"]);
  scannedCount.textContent = st.scanned ?? 0;
  blockedCount.textContent = st.blocked ?? 0;

  const enabled = st.monitoringEnabled === true; // default OFF until user enables
  toggle.checked = enabled;

  fpTitle.textContent = enabled ? "Fingerprint Matching Active" : "Protection Paused";
  fpSub.textContent = enabled
    ? "Monitoring pages for fingerprint matches…"
    : "Turn on Real-Time Protection to monitor media fingerprints.";
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ monitoringEnabled: enabled });
  await sendToActiveTab({ type: "SET_MONITORING", enabled });
  await refreshUI();
});

btnAnalyzeNow.addEventListener("click", async () => {
  analyzeMsg.textContent = "Capturing screen and sending to backend…";
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN_AND_SEND" });
  if (res?.ok) analyzeMsg.textContent = `Sent. analysis_id: ${res.analysis_id ?? "n/a"}`;
  else analyzeMsg.textContent = `Failed: ${res?.error || "capture/send failed"}`;
});

openDashboard.addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: DASHBOARD_URL });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "COUNTS_UPDATED") refreshUI();
});

refreshUI();
