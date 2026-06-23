// FaceTracker — the 24/7 display.
// Webcam -> MediaPipe face mesh -> WebGL paint/sticker warp + DOM overlays.
// Reacts live to control-panel changes over the BroadcastChannel.

import { STORES, MSG, COLOR_FILTERS, IS_ELECTRON } from './config.js';
import { getAll, getSettings } from './store.js';
import { createBus } from './bus.js';
import { loadFaceLandmarker, FaceTracks } from './tracker.js';
import { createRenderer, createMapper } from './renderer.js';
import { createOverlayLayer } from './overlays.js';

// Capture recent errors/warnings for the diagnostics report.
const diagLogs = [];
function diagLog(kind, parts) {
  try {
    diagLogs.push((`${new Date().toISOString().slice(11, 19)} ${kind}: ` + parts.map((p) => (p && p.message ? p.message : String(p))).join(' ')).slice(0, 300));
    while (diagLogs.length > 40) diagLogs.shift();
  } catch {}
}
{
  const ce = console.error.bind(console);
  console.error = (...a) => { diagLog('ERR', a); ce(...a); };
  const cw = console.warn.bind(console);
  console.warn = (...a) => { diagLog('WARN', a); cw(...a); };
}
window.addEventListener('error', (e) => diagLog('ERR', [e.message || e.error || 'error']));
window.addEventListener('unhandledrejection', (e) => diagLog('ERR', ['unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)]));

const video = document.getElementById('cam');
const glCanvas = document.getElementById('gl');
const overlayEl = document.getElementById('overlays');
const gate = document.getElementById('gate');
const messageEl = document.getElementById('message');
const fpsEl = document.getElementById('fps');
const duotoneFns = { r: document.getElementById('dt-r'), g: document.getElementById('dt-g'), b: document.getElementById('dt-b') };

function hexToRgb01(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function applyDuotone() {
  const d = hexToRgb01(settings.duotoneDark);
  const l = hexToRgb01(settings.duotoneLight);
  if (duotoneFns.r) duotoneFns.r.setAttribute('tableValues', `${d[0]} ${l[0]}`);
  if (duotoneFns.g) duotoneFns.g.setAttribute('tableValues', `${d[1]} ${l[1]}`);
  if (duotoneFns.b) duotoneFns.b.setAttribute('tableValues', `${d[2]} ${l[2]}`);
}

const bus = createBus('display');
let renderer, overlayLayer, landmarker, tracks;
let settings;
let paints = [];
let stickers = [];
let paintsById = new Map();
const paintAssign = new Map(); // trackId -> paintId (randomPerFace mode)

let running = false;
let lastTs = 0;
let needLandmarkerReload = false;
let fps = 0,
  fpsAccum = 0,
  fpsCount = 0,
  fpsLast = performance.now();
let engineSource = null;
let engineModule = '';
let lastFaceCount = 0;

// ---------------------------------------------------------------------------
// Asset loading
// ---------------------------------------------------------------------------
async function decodeTo(rec, id) {
  try {
    const bmp = await createImageBitmap(rec.blob);
    renderer.upsertTexture(id, bmp, rec.updatedAt || 0);
    if (bmp.close) bmp.close();
  } catch (e) {
    console.warn('Failed to decode asset', id, e);
  }
}

async function loadPaints() {
  paints = await getAll(STORES.paints);
  paintsById = new Map(paints.map((p) => [p.id, p]));
  for (const p of paints) await decodeTo(p, p.id);
  syncTextures();
}

async function loadStickers() {
  stickers = await getAll(STORES.stickers);
  for (const s of stickers) await decodeTo(s, s.id);
  syncTextures();
}

function syncTextures() {
  if (!renderer) return;
  renderer.pruneTextures([...paints.map((p) => p.id), ...stickers.map((s) => s.id)]);
}

async function loadOverlays() {
  const overlays = await getAll(STORES.overlays);
  overlayLayer.render(overlays);
}

function applyVideoStyle() {
  video.style.transform = settings.mirror ? 'scaleX(-1)' : 'none';
  video.style.filter = COLOR_FILTERS[settings.colorFilter] || '';
  document.body.style.background = settings.bgColor || '#000';
  applyDuotone();
}

async function loadSettings() {
  const prev = settings;
  settings = await getSettings();
  applyVideoStyle();
  if (tracks) tracks.setSmoothing(settings.smoothing);
  fpsEl.style.display = settings.showFps ? 'block' : 'none';
  if (prev && (prev.numFaces !== settings.numFaces || prev.detectorDelegate !== settings.detectorDelegate)) {
    needLandmarkerReload = true;
  }
  if (prev && prev.cameraId !== settings.cameraId && running) {
    await startCamera();
  }
}

// ---------------------------------------------------------------------------
// Paint selection
// ---------------------------------------------------------------------------
function enabledPaintIds() {
  const set = settings.enabledPaintIds && settings.enabledPaintIds.length ? settings.enabledPaintIds : paints.map((p) => p.id);
  return set.filter((id) => paintsById.has(id));
}

function paintFor(track) {
  if (settings.paintMode === 'randomPerFace') {
    let pid = paintAssign.get(track.id);
    if (!pid || !paintsById.has(pid)) {
      const pool = enabledPaintIds();
      if (!pool.length) return null;
      pid = pool[Math.floor(Math.random() * pool.length)];
      paintAssign.set(track.id, pid);
    }
    return pid;
  }
  return settings.activePaintId && paintsById.has(settings.activePaintId) ? settings.activePaintId : null;
}

// ---------------------------------------------------------------------------
// Camera + detector
// ---------------------------------------------------------------------------
async function startCamera() {
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  const constraints = {
    audio: false,
    video: settings.cameraId
      ? { deviceId: { exact: settings.cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
}

async function ensureLandmarker() {
  if (landmarker) {
    try {
      landmarker.close();
    } catch {}
    landmarker = null;
  }
  const res = await loadFaceLandmarker({ numFaces: settings.numFaces, delegate: settings.detectorDelegate });
  landmarker = res.landmarker;
  engineSource = res.source;
  engineModule = res.module;
  needLandmarkerReload = false;
}

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (renderer.gl.canvas.width !== w || renderer.gl.canvas.height !== h) renderer.resize(w, h);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function frame() {
  if (!running) return;

  if (needLandmarkerReload) {
    running = false;
    ensureLandmarker().then(() => {
      running = true;
      schedule();
    });
    return;
  }

  if (video.readyState >= 2 && video.videoWidth) {
    fitCanvas();
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    let result;
    try {
      result = landmarker.detectForVideo(video, ts);
    } catch (e) {
      console.error('detect error', e);
    }
    const active = tracks.update(result ? result.faceLandmarks : [], ts);
    lastFaceCount = active.length;

    // Drop paint assignments for faces that are gone.
    if (paintAssign.size) {
      const live = new Set(active.map((t) => t.id));
      for (const id of [...paintAssign.keys()]) if (!live.has(id)) paintAssign.delete(id);
    }

    const mapper = createMapper(renderer.gl.canvas.width, renderer.gl.canvas.height, video.videoWidth, video.videoHeight, settings.mirror);
    renderer.render({
      tracks: active,
      mapper,
      paintFor,
      opacity: settings.paintOpacity,
      stickers,
      meshDebug: settings.meshDebug,
      occlusion: settings.occlusion !== false,
      edgeFeather: settings.edgeFeather ?? 0.6,
    });

    // FPS
    const now = performance.now();
    fpsAccum += now - fpsLast;
    fpsLast = now;
    fpsCount++;
    if (fpsAccum >= 500) {
      fps = Math.round((fpsCount * 1000) / fpsAccum);
      fpsAccum = 0;
      fpsCount = 0;
      if (settings.showFps) fpsEl.textContent = `${fps} fps · ${active.length} face${active.length === 1 ? '' : 's'}`;
    }
  }
  schedule();
}

function schedule() {
  if (!running) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => frame());
  else requestAnimationFrame(() => frame());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function showMessage(html) {
  messageEl.innerHTML = html;
  messageEl.style.display = html ? 'flex' : 'none';
}

async function start() {
  gate.style.display = 'none';
  showMessage('Loading face engine…');
  try {
    settings = await getSettings();
    renderer = createRenderer(glCanvas);
    overlayLayer = createOverlayLayer(overlayEl);
    tracks = new FaceTracks({ smoothing: settings.smoothing });
    applyVideoStyle();
    fpsEl.style.display = settings.showFps ? 'block' : 'none';

    await ensureLandmarker();
    showMessage('Starting camera…');
    await startCamera();
    await Promise.all([loadPaints(), loadStickers(), loadOverlays()]);

    showMessage('');
    running = true;
    fitCanvas();
    schedule();
  } catch (e) {
    console.error(e);
    showMessage(
      `<div><strong>Couldn't start.</strong><br>${escapeHtml(e.message || String(e))}<br><br>` +
        `Check camera permission and your internet connection, then <button id="retry">retry</button>.</div>`
    );
    const r = document.getElementById('retry');
    if (r) r.onclick = () => location.reload();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Snapshot of the display's runtime state for the diagnostics report.
function buildDiag() {
  let webgl = 'n/a';
  try {
    const gl = renderer && renderer.gl;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const v2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      webgl = `${v2 ? 'WebGL2' : 'WebGL1'} — ${r}`;
    }
  } catch {}
  const track = video.srcObject && video.srcObject.getVideoTracks ? video.srcObject.getVideoTracks()[0] : null;
  const ts = track && track.getSettings ? track.getSettings() : {};
  return {
    version: (window.FT_CONFIG && window.FT_CONFIG.version) || 'web',
    running,
    engine: engineSource || '(not loaded yet)',
    engineModule,
    webgl,
    cameraLabel: track ? track.label || '(unnamed)' : '(no camera)',
    resolution: video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : '(no video)',
    cameraFps: ts.frameRate ? Math.round(ts.frameRate) : null,
    fps,
    faces: lastFaceCount,
    recentLogs: diagLogs.slice(-15),
  };
}

// Live updates from the control panel.
bus.on(async (msg) => {
  if (msg.type === MSG.PING && msg.role !== 'display') bus.pong();
  if (msg.type === MSG.DIAG_REQUEST) bus.post(MSG.DIAG_REPORT, { diag: buildDiag() });
  if (msg.type === MSG.CHANGED) {
    if (msg.store === STORES.settings) await loadSettings();
    else if (msg.store === STORES.paints) await loadPaints();
    else if (msg.store === STORES.stickers) await loadStickers();
    else if (msg.store === STORES.overlays) await loadOverlays();
  }
  if (msg.type === MSG.COMMAND && msg.command === 'reload') location.reload();
});
setInterval(() => bus.hello(), 2000);

// Kiosk keyboard shortcuts.
window.addEventListener('keydown', (e) => {
  if (e.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  } else if (e.key === 'd' && settings) {
    settings.meshDebug = !settings.meshDebug;
  } else if (e.key === 'i' && fpsEl) {
    fpsEl.style.display = fpsEl.style.display === 'none' ? 'block' : 'none';
  }
});

gate.querySelector('button').addEventListener('click', start);
window.addEventListener('resize', () => renderer && fitCanvas());

// In the desktop app, camera permission is auto-granted — start immediately so
// the display comes up on its own for unattended / 24-7 installs.
if (IS_ELECTRON) start();
