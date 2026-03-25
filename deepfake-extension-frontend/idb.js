// idb.js — IndexedDB helper for the local blocklist cache.
// Stores fingerprint_hash (aHash), video_id, and source_url for fast matching.
const DB_NAME = "deepfake_blocklist_db";
const DB_VER = 3; // v3 adds thumbnail_phash for Layer B pHash matching
const STORE = "blocklist";
const META_STORE = "meta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (evt) => {
      const db = req.result;
      // Primary blocklist store keyed by fingerprint_hash
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "fingerprint_hash" });
        s.createIndex("by_video_id", "video_id", { unique: false });
      } else if (evt.oldVersion < 2) {
        // Add the video_id index on upgrade
        const tx = evt.target.transaction;
        const s = tx.objectStore(STORE);
        if (!s.indexNames.contains("by_video_id")) {
          s.createIndex("by_video_id", "video_id", { unique: false });
        }
      }
      // Meta store for sync timestamps
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a full blocklist entry (from backend sync) */
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
      thumbnail_phash: entry.thumbnail_phash || null, // Layer B
      synced_at: Date.now(),
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** Legacy: store a bare hash (from aHash matching) */
async function idbPut(hash) {
  return idbPutEntry({ fingerprint_hash: hash });
}

/** Check if a perceptual hash is in the blocklist */
async function idbHas(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(hash);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Get full entry object by fingerprint hash (returns null if not found) */
async function idbGetEntry(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(hash);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Get full entry object by video_id (returns null if not found) */
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

/** Check if a video_id is in the blocklist */
async function idbHasVideoId(videoId) {
  if (!videoId) return false;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("by_video_id").getKey(videoId);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Bulk replace the entire blocklist with fresh entries from backend */
async function idbBulkSync(entries) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    const store = tx.objectStore(STORE);
    const meta = tx.objectStore(META_STORE);

    // Clear existing and re-populate
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
        thumbnail_phash: entry.thumbnail_phash || null, // Layer B
        synced_at: Date.now(),
      });
    }
    meta.put({ key: "last_synced_at", value: Date.now() });

    tx.oncomplete = () => resolve(entries.length);
    tx.onerror = () => reject(tx.error);
  });
}

/** Get timestamp of last sync */
async function idbGetLastSyncedAt() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get("last_synced_at");
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Layer B: get all active blocklist entries (including thumbnail_phash) */
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

async function idbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

self.DeepfakeIDB = {
  _openDB: openDB,
  idbPut,
  idbPutEntry,
  idbHas,
  idbGetEntry,
  idbHasVideoId,
  idbGetByVideoId,
  idbBulkSync,
  idbGetLastSyncedAt,
  idbGetAllActive,
  idbClear,
};
