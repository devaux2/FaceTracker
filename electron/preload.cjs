// FaceTracker — Electron preload.
// Exposes a small, safe API to the page: a config object (electron flag, app
// version, offline-vendor base) and an updater bridge.
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let version = '0.0.0';
try {
  version = require('../package.json').version;
} catch {}

function detectVendor() {
  const base = path.join(__dirname, '..', 'vendor');
  try {
    const haveWasm = fs.existsSync(path.join(base, 'tasks-vision', 'wasm'));
    const haveBundle = fs.existsSync(path.join(base, 'tasks-vision', 'vision_bundle.mjs'));
    const haveModel = fs.existsSync(path.join(base, 'face_landmarker.task'));
    return haveWasm && haveBundle && haveModel ? '/vendor' : null;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('FT_CONFIG', {
  electron: true,
  platform: process.platform,
  version,
  mediapipeVendorBase: detectVendor(),
});

contextBridge.exposeInMainWorld('FT_UPDATE', {
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
  openExternal: (u) => ipcRenderer.invoke('app:openExternal', u),
  onEvent: (cb) => ipcRenderer.on('updates:event', (_e, payload) => cb(payload)),
});
