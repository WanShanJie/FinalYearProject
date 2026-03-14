# Deepfake Extension v0.2.1

## Two independent features
1) **Real-Time Protection** toggle
- Persistent (stored in chrome.storage.local as `monitoringEnabled`)
- When ON: content script monitors IMG/VIDEO, computes a demo aHash fingerprint, checks local IndexedDB blocklist, and marks matched media (no blur/block yet).
- When OFF: monitoring stops.
- Toggle state is remembered across pages and when reopening the popup.

2) **Analyze This Page Now**
- Works regardless of the toggle.
- Service worker captures a screenshot of current tab + page metadata and sends to backend:
  - POST `${API_BASE}/api/analysis/capture` with FormData(meta + files[])

## Configure backend
Edit `service_worker.js`:
- `const API_BASE = "http://127.0.0.1:8000";`

## Install
- chrome://extensions → Developer Mode → Load unpacked → select this folder.
