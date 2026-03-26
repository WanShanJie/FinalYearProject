// idb.js — IndexedDB helper for the local blocklist cache.
// Stores fingerprint_hash (aHash), video_id, and source_url for fast matching.

(function() {
  const DB_NAME = "deepfake_blocklist_db";
  const DB_VER = 3; 
  const STORE = "blocklist";
  const META_STORE = "meta";

  function openDB() {
    return new Promise((resolve, reject) => {
      const g = (typeof self !== 'undefined') ? self : window;
      const req = g.indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (evt) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "fingerprint_hash" });
          s.createIndex("by_video_id", "video_id", { unique: false });
        } else if (evt.oldVersion < 2) {
          const tx = evt.target.transaction;
          const s = tx.objectStore(STORE);
          if (!s.indexNames.contains("by_video_id")) {
            s.createIndex("by_video_id", "video_id", { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutEntry(entry) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        fingerprint_hash: entry.fingerprint_hash,
        video_id: entry.video_id || null,
        source_url: entry.source_url || null,
        platform: entry.platform || null,
        title: entry.title || null,
        verdict: entry.verdict || "FAKE",
        risk_score: entry.risk_score || 70,
        risk_level: entry.risk_level || "High",
        status: entry.status || "active",
        thumbnail_phash: entry.thumbnail_phash || null,
        synced_at: Date.now(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetEntry(hash) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(hash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetByVideoId(videoId) {
    if (!videoId) return null;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).index("by_video_id").get(videoId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbBulkSync(entries) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], "readwrite");
      const store = tx.objectStore(STORE);
      const meta = tx.objectStore(META_STORE);
      store.clear();
      for (const entry of entries) {
        store.put({
          fingerprint_hash: entry.fingerprint_hash,
          video_id: entry.video_id || null,
          source_url: entry.source_url || null,
          platform: entry.platform || null,
          title: entry.title || null,
          verdict: entry.verdict || "FAKE",
          risk_score: entry.risk_score || 70,
          risk_level: entry.risk_level || "High",
          status: entry.status || "active",
          thumbnail_phash: entry.thumbnail_phash || null,
          synced_at: Date.now(),
        });
      }
      meta.put({ key: "last_synced_at", value: Date.now() });
      tx.oncomplete = () => resolve(entries.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetAllActive() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(
        (req.result || []).filter(e => e.status === "active" || !e.status)
      );
      req.onerror = () => reject(req.error);
    });
  }

  const g = (typeof self !== 'undefined') ? self : window;
  g.DeepfakeIDB = {
    idbPutEntry,
    idbGetEntry,
    idbGetByVideoId,
    idbBulkSync,
    idbGetAllActive
  };
})();
