// FaceTracker — Electron preload.
// Exposes a small config object to the page. Most importantly it tells the app
// it's running inside Electron (so the display auto-starts) and, if the
// MediaPipe face engine has been vendored locally (npm run vendor:mediapipe),
// points the app at the local copy so it runs fully offline.
const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

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
  mediapipeVendorBase: detectVendor(), // '/vendor' when offline assets are present, else null (use CDN)
});
