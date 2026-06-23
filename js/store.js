// FaceTracker — persistence layer (IndexedDB).
// Holds paints, stickers, overlays (each may carry an image/video Blob) and a
// single settings record. Shared by the control panel and the display because
// they run on the same origin (localhost).

import { STORES, DEFAULT_SETTINGS } from './config.js';

const DB_NAME = 'facetracker';
const DB_VERSION = 1;
const SETTINGS_KEY = 'app';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.paints)) db.createObjectStore(STORES.paints, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.stickers)) db.createObjectStore(STORES.stickers, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.overlays)) db.createObjectStore(STORES.overlays, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// ---- generic CRUD ---------------------------------------------------------
export const getAll = (store) => tx(store, 'readonly', (s) => reqP(s.getAll()));
export const get = (store, id) => tx(store, 'readonly', (s) => reqP(s.get(id)));
export const put = (store, record) => tx(store, 'readwrite', (s) => reqP(s.put(record)));
export const del = (store, id) => tx(store, 'readwrite', (s) => reqP(s.delete(id)));
export const clear = (store) => tx(store, 'readwrite', (s) => reqP(s.clear()));

// ---- settings -------------------------------------------------------------
export async function getSettings() {
  const rec = await get(STORES.settings, SETTINGS_KEY);
  const { key, ...rest } = rec || {};
  return { ...DEFAULT_SETTINGS, ...rest };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await put(STORES.settings, { key: SETTINGS_KEY, ...next });
  return next;
}

// ---- helpers --------------------------------------------------------------
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

// ---- backup / restore -----------------------------------------------------
// Serialises everything (including Blobs as data URLs) into one JSON object so
// a configured kit can be moved between machines.
export async function exportAll() {
  const [paints, stickers, overlays, settings] = await Promise.all([
    getAll(STORES.paints),
    getAll(STORES.stickers),
    getAll(STORES.overlays),
    getSettings(),
  ]);

  const encode = async (records) =>
    Promise.all(
      records.map(async (r) => {
        const out = { ...r };
        if (r.blob instanceof Blob) {
          out.blob = await blobToDataURL(r.blob);
          out._blobType = r.blob.type;
        }
        return out;
      })
    );

  return {
    app: 'facetracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    paints: await encode(paints),
    stickers: await encode(stickers),
    overlays: await encode(overlays),
  };
}

export async function importAll(data, { merge = false } = {}) {
  if (!data || data.app !== 'facetracker') throw new Error('Not a FaceTracker backup file.');

  const decode = async (records) =>
    Promise.all(
      (records || []).map(async (r) => {
        const out = { ...r };
        if (typeof r.blob === 'string' && r.blob.startsWith('data:')) {
          out.blob = await dataURLToBlob(r.blob);
        }
        delete out._blobType;
        return out;
      })
    );

  if (!merge) {
    await Promise.all([clear(STORES.paints), clear(STORES.stickers), clear(STORES.overlays)]);
  }

  for (const p of await decode(data.paints)) await put(STORES.paints, p);
  for (const s of await decode(data.stickers)) await put(STORES.stickers, s);
  for (const o of await decode(data.overlays)) await put(STORES.overlays, o);
  if (data.settings) await saveSettings(data.settings);
}
