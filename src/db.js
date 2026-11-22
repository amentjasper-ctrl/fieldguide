// Local database for v1. No accounts: every record carries the device id, so
// moving this behind a server later means swapping these functions only.

const DB_NAME = "fieldguide";
const DB_VERSION = 2;
const ALBUM = "album";
const CACHE = "cache";
const PRINTS = "prints";

const DEVICE_KEY = "fieldguide.deviceId";
const NOTICE_KEY = "fieldguide.seenNotice";

let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ALBUM)) {
        db.createObjectStore(ALBUM, { keyPath: "id" }).createIndex("savedAt", "savedAt");
      }
      if (!db.objectStoreNames.contains(CACHE)) {
        db.createObjectStore(CACHE, { keyPath: "hash" });
      }
      // Small index of fingerprints, so a cache lookup never loads full photos.
      if (!db.objectStoreNames.contains(PRINTS)) {
        db.createObjectStore(PRINTS, { keyPath: "hash" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version take over instead of blocking the upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

function request(storeName, mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let req;
        try {
          req = run(db.transaction(storeName, mode).objectStore(storeName));
        } catch {
          resolve(null);
          return;
        }
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      }),
  );
}

/**
 * A write that answers whether it actually landed. IndexedDB reports a full
 * disk by aborting the transaction, not by failing the single request, so the
 * caller has to hear the outcome of the whole transaction.
 */
function write(storeName, run) {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(false);
          return;
        }
        let tx;
        try {
          tx = db.transaction(storeName, "readwrite");
        } catch {
          resolve(false);
          return;
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
        try {
          run(tx.objectStore(storeName));
        } catch {
          resolve(false);
        }
      }),
  );
}

// ---------------------------------------------------------------- device

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "unknown-device";
  }
}

// ---------------------------------------------------------------- album

export const albumAll = () => request(ALBUM, "readonly", (store) => store.getAll());

export const albumPut = (record) => write(ALBUM, (store) => store.put(record));

export const albumDelete = (id) => write(ALBUM, (store) => store.delete(id));

// ---------------------------------------------------------------- cache

export const cacheKeys = () => request(CACHE, "readonly", (store) => store.getAllKeys());

export const cacheGet = (hash) => request(CACHE, "readonly", (store) => store.get(hash));

export const cachePut = (record) => write(CACHE, (store) => store.put(record));

export const cacheDelete = (hash) => write(CACHE, (store) => store.delete(hash));

export const printsAll = () => request(PRINTS, "readonly", (store) => store.getAll());

export const printPut = (record) => write(PRINTS, (store) => store.put(record));

export const printDelete = (hash) => write(PRINTS, (store) => store.delete(hash));

// ---------------------------------------------------------------- notice

export function seenNotice() {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markNoticeSeen() {
  try {
    localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    /* nothing to do */
  }
}
