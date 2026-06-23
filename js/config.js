// FaceTracker — shared configuration and contracts.
// Everything tunable lives here so the rest of the app stays declarative.

// ---------------------------------------------------------------------------
// MediaPipe face engine.
// Loaded from a CDN by default. When running in the desktop (Electron) build
// with assets vendored locally (npm run vendor:mediapipe), the preload sets
// window.FT_CONFIG.mediapipeVendorBase and the app runs fully offline.
// ---------------------------------------------------------------------------
const OVERRIDES = (typeof window !== 'undefined' && window.FT_CONFIG) || {};
const MP_VERSION = '0.10.15';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;

const CDN_ENGINE = {
  version: MP_VERSION,
  // The `+esm` form is the most reliable for buildless ESM.
  module: `${MP_CDN}/+esm`,
  wasm: `${MP_CDN}/wasm`,
  // Face landmark model (468 face + 10 iris landmarks). ~3.8 MB.
  model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

const VENDOR_ENGINE = OVERRIDES.mediapipeVendorBase
  ? {
      version: MP_VERSION,
      module: `${OVERRIDES.mediapipeVendorBase}/tasks-vision/vision_bundle.mjs`,
      wasm: `${OVERRIDES.mediapipeVendorBase}/tasks-vision/wasm`,
      model: `${OVERRIDES.mediapipeVendorBase}/face_landmarker.task`,
    }
  : null;

// Use the bundled (offline) engine when present, else the CDN.
export const MEDIAPIPE = VENDOR_ENGINE || CDN_ENGINE;
// If the bundled engine fails to load at runtime, fall back to the CDN.
export const MEDIAPIPE_FALLBACK = VENDOR_ENGINE ? CDN_ENGINE : null;

// True when running inside the Electron desktop build.
export const IS_ELECTRON = !!OVERRIDES.electron;

// Cross-window messaging (control panel <-> display, same browser/origin).
export const CHANNEL_NAME = 'facetracker';

// IndexedDB object stores.
export const STORES = {
  paints: 'paints', // full-face mesh textures
  stickers: 'stickers', // anchored PNG/GIF stickers
  overlays: 'overlays', // text / image / video logos
  settings: 'settings', // single record, key = 'app'
};

// Message types carried over the BroadcastChannel.
export const MSG = {
  CHANGED: 'changed', // { store } — receiver reloads that store from IndexedDB
  HELLO_DISPLAY: 'hello-display', // display announces itself
  HELLO_CONTROL: 'hello-control', // control announces itself
  PING: 'ping',
  PONG: 'pong', // { role }
  COMMAND: 'command', // { command, ...args } transient actions (e.g. capture)
  DIAG_REQUEST: 'diag-request', // control asks the display for its runtime state
  DIAG_REPORT: 'diag-report', // { diag } display's runtime state
};

// Default display settings. The control panel edits a copy of this shape.
export const DEFAULT_SETTINGS = {
  cameraId: null, // selected webcam deviceId (null = browser default)
  mirror: true, // selfie-mirror the feed (magic-mirror installs want this)
  colorFilter: 'none', // 'none' | 'grayscale' | 'duotone' | 'sepia' | 'noir'
  duotoneDark: '#0b0b12',
  duotoneLight: '#f5f5ff',
  numFaces: 5, // max simultaneous faces to detect (1–10)
  paintOpacity: 1.0, // 0–1 global opacity for face paint
  paintMode: 'single', // 'single' (activePaintId) | 'randomPerFace' (enabled set)
  activePaintId: null,
  enabledPaintIds: [], // used in randomPerFace mode (empty = all paints)
  smoothing: 0.4, // 0 = raw landmarks, →1 = heavy temporal smoothing (One-Euro). Lower = snappier.
  occlusion: true, // depth-based occlusion (hides folds/far side; never deletes the visible face)
  edgeFeather: 0.45, // edge softness: 0 = hard edge, →1 = soft gradient reaching further into the face (solid middle, soft edge)
  showFps: false,
  meshDebug: false, // draw wireframe instead of texture
  bgColor: '#000000', // shown when no camera / letterboxing
  detectorDelegate: 'GPU', // 'GPU' | 'CPU'
};

// Named MediaPipe landmark indices we rely on (468-point mesh).
export const LM = {
  noseTip: 1,
  noseBridge: 168,
  foreheadTop: 10,
  foreheadCenter: 151,
  chin: 152,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  rightEyeOuter: 263,
  rightEyeInner: 362,
  leftIris: 468, // present only in the 478-landmark output
  rightIris: 473,
  mouthLeft: 61,
  mouthRight: 291,
  mouthTop: 13,
  mouthBottom: 14,
  faceLeft: 234, // silhouette extremes (face width)
  faceRight: 454,
};

// Sticker anchor presets. `pos` = landmark(s) the sticker centers on
// (two -> midpoint + angle between them). `scaleRef` = landmark pair whose
// pixel distance drives the sticker's base size.
export const STICKER_ANCHORS = {
  eyes: { label: 'Across the eyes', pos: [LM.leftEyeOuter, LM.rightEyeOuter], scaleRef: [LM.leftEyeOuter, LM.rightEyeOuter] },
  forehead: { label: 'Forehead', pos: [LM.foreheadTop], scaleRef: [LM.faceLeft, LM.faceRight] },
  nose: { label: 'Nose', pos: [LM.noseTip], scaleRef: [LM.leftEyeOuter, LM.rightEyeOuter] },
  mouth: { label: 'Mouth', pos: [LM.mouthLeft, LM.mouthRight], scaleRef: [LM.mouthLeft, LM.mouthRight] },
  chin: { label: 'Chin', pos: [LM.chin], scaleRef: [LM.faceLeft, LM.faceRight] },
  face: { label: 'Whole face', pos: [LM.noseTip], scaleRef: [LM.faceLeft, LM.faceRight] },
};

export const COLOR_FILTERS = {
  none: '',
  grayscale: 'grayscale(1) contrast(1.05)',
  noir: 'grayscale(1) contrast(1.35) brightness(0.95)',
  sepia: 'sepia(0.7) contrast(1.05)',
  duotone: 'url(#ft-duotone)', // SVG filter defined in display.html
};
