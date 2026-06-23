// FaceTracker — control panel ("CRM").
// Manage paints, stickers and overlays, tune the display, and watch whether a
// display window is live. Every change is written to IndexedDB and broadcast so
// the display updates instantly.

import { STORES, STICKER_ANCHORS, COLOR_FILTERS, DEFAULT_SETTINGS, MSG } from './config.js';
import * as store from './store.js';
import { createBus, trackPresence } from './bus.js';
import { buildTemplateCanvas, buildSamplePaintCanvas, downloadCanvas } from './template.js';
import { createOverlayLayer } from './overlays.js';
import { detectFaceOnImage } from './tracker.js';

const bus = createBus('control');

const state = { tab: 'paints', settings: { ...DEFAULT_SETTINGS }, paints: [], stickers: [], overlays: [] };
let objectUrls = [];
let cameras = [];
let overlayPreview = null;
let updateStatusText = '';
let diagText = '';
let awaitingDiag = null;

// ---- tiny DOM helpers -----------------------------------------------------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
}
const thumbUrl = (blob) => {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
};
function field(label, control, hint) {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, label), control, hint ? el('span', { class: 'hint' }, hint) : null]);
}
function slider(value, min, max, step, oninput) {
  return el('input', { type: 'range', min, max, step, value, oninput: (e) => oninput(parseFloat(e.target.value)) });
}
function smoothstep01(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
// CSS preview of the edge gradient: matches the shader (start/end position +
// hardness + edge opacity), sampled across edge(left) -> centre(right).
function edgeGradientCss(op, start, end, hardness) {
  const lo = 0.5 * hardness;
  const hi = 1 - 0.5 * hardness;
  const N = 18;
  const stops = [];
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    const t = Math.min(1, Math.max(0, (x - start) / Math.max(end - start, 0.001)));
    const a = op + (1 - op) * smoothstep01(lo, hi, t);
    stops.push(`rgba(255,45,139,${a.toFixed(3)}) ${(x * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

// ---- persistence wrappers -------------------------------------------------
async function patchSettings(patch) {
  state.settings = await store.saveSettings(patch);
  bus.changed(STORES.settings);
}
async function savePaint(rec) {
  // Keep updatedAt (only changes when the image changes) so the display doesn't
  // re-decode the texture for name/fit edits.
  await store.put(STORES.paints, rec);
  bus.changed(STORES.paints);
  await refresh();
}
async function saveSticker(rec) {
  await store.put(STORES.stickers, rec);
  bus.changed(STORES.stickers);
}

const DEFAULT_FIT = { ox: 0, oy: 0, scale: 1, rot: 0 };
async function savePaintFit(p) {
  await store.put(STORES.paints, p);
  bus.changed(STORES.paints);
}

// Auto-fit: detect the paint image's own face and store its landmark positions
// as that paint's texture coordinates, so every painted feature maps exactly
// onto the matching face landmark. Falls back to the default mapping if no face.
const fitStatus = new Map(); // paintId -> status text
function updateFitStatus(id) {
  const node = document.getElementById('fitstatus-' + id);
  if (node) node.textContent = fitStatus.get(id) || '';
}
async function autoFitPaint(id) {
  fitStatus.set(id, 'Aligning…');
  updateFitStatus(id);
  try {
    const p = await store.get(STORES.paints, id);
    if (!p || !p.blob) return;
    const bmp = await createImageBitmap(p.blob);
    const lm = await detectFaceOnImage(bmp);
    if (bmp.close) bmp.close();
    if (!lm) {
      fitStatus.set(id, 'No face detected — using default mapping');
      updateFitStatus(id);
      return;
    }
    const uv = new Array(468 * 2);
    for (let i = 0; i < 468; i++) {
      uv[i * 2] = lm[i].x;
      uv[i * 2 + 1] = lm[i].y;
    }
    p.uvCoords = uv;
    await store.put(STORES.paints, p);
    bus.changed(STORES.paints);
    fitStatus.set(id, 'Auto-aligned ✓');
    updateFitStatus(id);
  } catch (e) {
    console.error('auto-fit failed', e);
    fitStatus.set(id, 'Auto-fit failed (is the engine reachable?)');
    updateFitStatus(id);
  }
}
async function clearAutoFit(id) {
  const p = await store.get(STORES.paints, id);
  if (!p) return;
  delete p.uvCoords;
  await store.put(STORES.paints, p);
  bus.changed(STORES.paints);
  fitStatus.set(id, 'Using default mapping');
  await refresh();
}
async function saveOverlay(rec) {
  await store.put(STORES.overlays, { ...rec, updatedAt: Date.now() });
  bus.changed(STORES.overlays);
}

async function refresh() {
  [state.paints, state.stickers, state.overlays, state.settings] = await Promise.all([
    store.getAll(STORES.paints),
    store.getAll(STORES.stickers),
    store.getAll(STORES.overlays),
    store.getSettings(),
  ]);
  state.overlays.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  render();
}

// ===========================================================================
// Tabs
// ===========================================================================
function renderPaints() {
  const s = state.settings;
  const modeRow = el('div', { class: 'row' }, [
    el('label', { class: 'radio' }, [
      el('input', { type: 'radio', name: 'pmode', checked: s.paintMode === 'single', onchange: () => patchSettings({ paintMode: 'single' }).then(render) }),
      'Single active paint',
    ]),
    el('label', { class: 'radio' }, [
      el('input', { type: 'radio', name: 'pmode', checked: s.paintMode === 'randomPerFace', onchange: () => patchSettings({ paintMode: 'randomPerFace' }).then(render) }),
      'Random paint per face',
    ]),
  ]);

  const opacity = field(
    `Paint opacity (${Math.round(s.paintOpacity * 100)}%)`,
    slider(s.paintOpacity, 0, 1, 0.05, (v) => patchSettings({ paintOpacity: v }))
  );

  const drop = el('div', { class: 'dropzone' }, ['Drop face-paint images here, or ', el('label', { class: 'link' }, ['browse', fileInput('image/*', true, addPaints)])]);
  wireDrop(drop, (files) => addPaints({ target: { files } }));

  const grid = el('div', { class: 'grid' }, state.paints.map((p) => paintCard(p)));
  if (!state.paints.length) grid.append(el('p', { class: 'empty' }, 'No paints yet. Upload a transparent PNG painted on the template below.'));

  const tmpl = el('button', { class: 'btn ghost', onclick: () => downloadCanvas(buildTemplateCanvas({ size: 2048 }), 'facetracker-template.png') }, '⬇ Download paint template');
  const sample = el('button', { class: 'btn ghost', onclick: addSamplePaint }, '✨ Add sample skull paint');

  return el('div', {}, [el('h2', {}, 'Face paints'), modeRow, opacity, drop, grid, el('div', { class: 'row' }, [sample, tmpl])]);
}

function paintCard(p) {
  const s = state.settings;
  const isSingle = s.paintMode === 'single';
  const active = isSingle ? s.activePaintId === p.id : (s.enabledPaintIds || []).includes(p.id) || !(s.enabledPaintIds || []).length;
  const select = isSingle
    ? el('label', { class: 'radio' }, [el('input', { type: 'radio', name: 'active', checked: s.activePaintId === p.id, onchange: () => patchSettings({ activePaintId: p.id }).then(render) }), 'Active'])
    : el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          checked: (s.enabledPaintIds || []).includes(p.id),
          onchange: (e) => {
            const set = new Set(s.enabledPaintIds || []);
            e.target.checked ? set.add(p.id) : set.delete(p.id);
            patchSettings({ enabledPaintIds: [...set] }).then(render);
          },
        }),
        'In rotation',
      ]);

  const fit = { ...DEFAULT_FIT, ...(p.fit || {}) };
  const updFit = (patch) => {
    Object.assign(fit, patch);
    p.fit = { ...fit };
    savePaintFit(p);
  };
  const fitUI = el('details', { class: 'fit' }, [
    el('summary', {}, 'Adjust fit'),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn sm', onclick: () => autoFitPaint(p.id) }, '✨ Auto-fit to design'),
      p.uvCoords ? el('button', { class: 'btn ghost sm', onclick: () => clearAutoFit(p.id) }, 'Use default') : null,
      el('span', { id: 'fitstatus-' + p.id, class: 'hint' }, fitStatus.get(p.id) || (p.uvCoords ? 'Auto-aligned ✓' : '')),
    ]),
    el('p', { class: 'hint' }, 'Fine-tune on top of auto-fit:'),
    field('Offset X', slider(fit.ox, -0.2, 0.2, 0.005, (v) => updFit({ ox: v }))),
    field('Offset Y', slider(fit.oy, -0.2, 0.2, 0.005, (v) => updFit({ oy: v }))),
    field('Scale', slider(fit.scale, 0.7, 1.4, 0.01, (v) => updFit({ scale: v }))),
    field('Rotate', slider(fit.rot, -25, 25, 0.5, (v) => updFit({ rot: v }))),
    el('button', { class: 'btn ghost sm', onclick: () => { p.fit = { ...DEFAULT_FIT }; savePaintFit(p); render(); } }, 'Reset fit'),
  ]);

  return el('div', { class: 'card' + (isSingle && active ? ' card-active' : '') }, [
    el('div', { class: 'thumb checker' }, el('img', { src: thumbUrl(p.blob) })),
    el('input', {
      class: 'name',
      value: p.name || '',
      onchange: (e) => savePaint({ ...p, name: e.target.value }),
    }),
    el('div', { class: 'card-row' }, [select, el('button', { class: 'btn danger sm', onclick: () => deletePaint(p) }, 'Delete')]),
    fitUI,
  ]);
}

function renderStickers() {
  const drop = el('div', { class: 'dropzone' }, ['Drop sticker images (transparent PNG) here, or ', el('label', { class: 'link' }, ['browse', fileInput('image/*', true, addStickers)])]);
  wireDrop(drop, (files) => addStickers({ target: { files } }));
  const grid = el('div', { class: 'grid' }, state.stickers.map(stickerCard));
  if (!state.stickers.length) grid.append(el('p', { class: 'empty' }, 'No stickers. Stickers pin a PNG to a face feature (eyes, forehead, …).'));
  return el('div', {}, [el('h2', {}, 'Stickers'), drop, grid]);
}

function stickerCard(s) {
  const upd = (patch) => {
    Object.assign(s, patch);
    saveSticker(s);
  };
  const anchorSel = el(
    'select',
    { onchange: (e) => upd({ anchor: e.target.value }) },
    Object.entries(STICKER_ANCHORS).map(([k, v]) => el('option', { value: k, selected: s.anchor === k }, v.label))
  );
  return el('div', { class: 'card wide' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'thumb sm checker' }, el('img', { src: thumbUrl(s.blob) })),
      el('input', { class: 'name', value: s.name || '', onchange: (e) => upd({ name: e.target.value }) }),
      el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: s.enabled !== false, onchange: (e) => upd({ enabled: e.target.checked }) }), 'On']),
      el('button', { class: 'btn danger sm', onclick: () => deleteSticker(s) }, 'Delete'),
    ]),
    field('Anchor', anchorSel),
    field(`Scale (${(s.scale ?? 1.5).toFixed(1)}×)`, slider(s.scale ?? 1.5, 0.2, 5, 0.1, (v) => upd({ scale: v }))),
    field(`Rotation (${s.rotation || 0}°)`, slider(s.rotation || 0, -180, 180, 1, (v) => upd({ rotation: v }))),
    field(`Offset X (${(s.offsetX || 0).toFixed(2)})`, slider(s.offsetX || 0, -1.5, 1.5, 0.05, (v) => upd({ offsetX: v }))),
    field(`Offset Y (${(s.offsetY || 0).toFixed(2)})`, slider(s.offsetY || 0, -1.5, 1.5, 0.05, (v) => upd({ offsetY: v }))),
    field(`Opacity (${Math.round((s.opacity ?? 1) * 100)}%)`, slider(s.opacity ?? 1, 0, 1, 0.05, (v) => upd({ opacity: v }))),
  ]);
}

function renderOverlays() {
  const add = el('div', { class: 'row' }, [
    el('button', { class: 'btn', onclick: addText }, '+ Text'),
    el('label', { class: 'btn' }, ['+ Image', fileInput('image/*', false, (e) => addMediaOverlay(e, 'image'))]),
    el('label', { class: 'btn' }, ['+ Video logo', fileInput('video/*', false, (e) => addMediaOverlay(e, 'video'))]),
  ]);
  const preview = el('div', { class: 'ov-preview' }, el('div', { id: 'ovPreview', class: 'ov-preview-inner' }));
  const list = el('div', {}, state.overlays.map((o, i) => overlayCard(o, i)));
  if (!state.overlays.length) list.append(el('p', { class: 'empty' }, 'No overlays. Add text, an image logo, or a looping video logo.'));
  const wrap = el('div', {}, [el('h2', {}, 'Overlays'), add, el('p', { class: 'hint' }, 'Preview (positions only — the live webcam shows behind these on the display):'), preview, list]);
  // (re)mount preview after it is in the DOM
  setTimeout(() => {
    overlayPreview = createOverlayLayer(document.getElementById('ovPreview'));
    overlayPreview.render(state.overlays);
  }, 0);
  return wrap;
}

function overlayCard(o, i) {
  const upd = (patch) => {
    Object.assign(o, patch);
    saveOverlay(o);
    if (overlayPreview) overlayPreview.render(state.overlays);
  };
  const head = el('div', { class: 'card-head' }, [
    el('strong', {}, o.kind === 'text' ? '🅣 Text' : o.kind === 'image' ? '🖼 Image' : '🎬 Video'),
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: o.enabled !== false, onchange: (e) => upd({ enabled: e.target.checked }) }), 'On']),
    el('button', { class: 'btn sm ghost', onclick: () => moveOverlay(o, -1) }, '↑'),
    el('button', { class: 'btn sm ghost', onclick: () => moveOverlay(o, 1) }, '↓'),
    el('button', { class: 'btn danger sm', onclick: () => deleteOverlay(o) }, 'Delete'),
  ]);

  const common = [
    field(`X (${o.x ?? 50}%)`, slider(o.x ?? 50, 0, 100, 0.5, (v) => upd({ x: v }))),
    field(`Y (${o.y ?? 50}%)`, slider(o.y ?? 50, 0, 100, 0.5, (v) => upd({ y: v }))),
    field(`Rotation (${o.rotation || 0}°)`, slider(o.rotation || 0, -180, 180, 1, (v) => upd({ rotation: v }))),
    field(`Opacity (${Math.round((o.opacity ?? 1) * 100)}%)`, slider(o.opacity ?? 1, 0, 1, 0.05, (v) => upd({ opacity: v }))),
  ];

  let specific = [];
  if (o.kind === 'text') {
    specific = [
      field('Text', el('textarea', { rows: 2, oninput: (e) => upd({ text: e.target.value }) }, o.text || '')),
      field(`Size (${o.fontSize ?? 8})`, slider(o.fontSize ?? 8, 1, 40, 0.5, (v) => upd({ fontSize: v }))),
      field('Colour', el('input', { type: 'color', value: o.color || '#ffffff', oninput: (e) => upd({ color: e.target.value }) })),
      field('Background', el('input', { type: 'color', value: o.bg && o.bg !== 'transparent' ? o.bg : '#ff2d8b', oninput: (e) => upd({ bg: e.target.value }) })),
      el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: o.bg === undefined || o.bg === 'transparent', onchange: (e) => upd({ bg: e.target.checked ? 'transparent' : '#ff2d8b' }) }), 'Transparent background']),
      el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: !!o.bold, onchange: (e) => upd({ bold: e.target.checked }) }), 'Bold']),
    ];
  } else {
    specific = [field(`Width (${o.widthPct ?? 20}%)`, slider(o.widthPct ?? 20, 2, 100, 0.5, (v) => upd({ widthPct: v })))];
    if (o.kind === 'video') specific.push(el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: o.loop !== false, onchange: (e) => upd({ loop: e.target.checked }) }), 'Loop']));
  }

  return el('div', { class: 'card wide' }, [head, ...specific, el('div', { class: 'two-col' }, common)]);
}

function renderDisplay() {
  const s = state.settings;
  const camSel = el(
    'select',
    { onchange: (e) => patchSettings({ cameraId: e.target.value || null }) },
    [el('option', { value: '', selected: !s.cameraId }, 'Default camera'), ...cameras.map((c, i) => el('option', { value: c.deviceId, selected: s.cameraId === c.deviceId }, c.label || `Camera ${i + 1}`))]
  );
  const enableCam = el('button', { class: 'btn ghost sm', onclick: listCameras }, 'Detect cameras');

  const filterSel = el(
    'select',
    { onchange: (e) => patchSettings({ colorFilter: e.target.value }).then(render) },
    Object.keys(COLOR_FILTERS).map((k) => el('option', { value: k, selected: s.colorFilter === k }, k))
  );

  const duo =
    s.colorFilter === 'duotone'
      ? el('div', { class: 'two-col' }, [
          field('Dark tone', el('input', { type: 'color', value: s.duotoneDark, oninput: (e) => patchSettings({ duotoneDark: e.target.value }) })),
          field('Light tone', el('input', { type: 'color', value: s.duotoneLight, oninput: (e) => patchSettings({ duotoneLight: e.target.value }) })),
        ])
      : null;

  return el('div', {}, [
    el('h2', {}, 'Display settings'),
    field('Camera', el('div', { class: 'row' }, [camSel, enableCam])),
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: s.mirror, onchange: (e) => patchSettings({ mirror: e.target.checked }) }), 'Mirror (selfie view)']),
    field('Colour look', filterSel),
    duo,
    field(
      'Max faces (1–10)',
      el('input', {
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        value: s.numFaces,
        onchange: (e) => patchSettings({ numFaces: Math.max(1, Math.min(10, Math.round(+e.target.value || 1))) }),
      })
    ),
    field(`Smoothing (${Math.round(s.smoothing * 100)}%)`, slider(s.smoothing, 0, 0.95, 0.05, (v) => patchSettings({ smoothing: v }))),
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: s.occlusion !== false, onchange: (e) => patchSettings({ occlusion: e.target.checked }) }), 'Occlusion — hide the far side when the head turns']),
    (() => {
      const g = { op: s.edgeOpacity ?? 0, st: s.gradStart ?? 0, en: s.gradEnd ?? 0.5, hd: s.gradHardness ?? 0 };
      const grad = el('div', { class: 'edge-grad' });
      const prev = el('div', { class: 'edge-preview checker' }, grad);
      const paint = () => { grad.style.background = edgeGradientCss(g.op, g.st, g.en, g.hd); };
      paint();
      return el('div', {}, [
        el('span', { class: 'field-label' }, 'Edge blend — left = edge of paint, right = centre of face'),
        prev,
        field('Edge opacity', slider(g.op, 0, 1, 0.02, (v) => { g.op = v; paint(); patchSettings({ edgeOpacity: v }); }), 'transparency at the edge (the simple control)'),
        el('div', { class: 'gradient-tool' }, [
          el('span', { class: 'field-label' }, 'Gradient tool'),
          field('Start', slider(g.st, 0, 1, 0.01, (v) => { g.st = v; paint(); patchSettings({ gradStart: v }); }), 'where the fade begins (edge → centre)'),
          field('End', slider(g.en, 0, 1, 0.01, (v) => { g.en = v; paint(); patchSettings({ gradEnd: v }); }), 'where the paint becomes fully solid'),
          field('Hardness', slider(g.hd, 0, 1, 0.02, (v) => { g.hd = v; paint(); patchSettings({ gradHardness: v }); }), 'smooth → harsh transition'),
        ]),
      ]);
    })(),
    field('Detector', el('select', { onchange: (e) => patchSettings({ detectorDelegate: e.target.value }) }, ['GPU', 'CPU'].map((d) => el('option', { value: d, selected: s.detectorDelegate === d }, d)))),
    field('Background', el('input', { type: 'color', value: s.bgColor, oninput: (e) => patchSettings({ bgColor: e.target.value }) })),
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: s.showFps, onchange: (e) => patchSettings({ showFps: e.target.checked }) }), 'Show FPS / face count on display']),
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: s.meshDebug, onchange: (e) => patchSettings({ meshDebug: e.target.checked }) }), 'Mesh debug (wireframe)']),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: () => bus.command('reload') }, '⟳ Reload display')),
  ]);
}

function renderHelp() {
  const children = [];
  if (window.FT_UPDATE) children.push(updatesSection());
  children.push(
    el('h2', {}, 'How to use'),
    el('ol', {}, [
      el('li', { html: 'The <b>Display</b> window shows the live painted feed. Press <b>F</b> for full screen; on a second monitor it goes full screen automatically.' }),
      el('li', { html: '<b>Add face paints</b> in the Paints tab: download the template, paint on it, export a <b>transparent PNG</b>, and upload it — or click <b>Add sample skull paint</b>.' }),
      el('li', { html: '<b>Pick a mode:</b> one active paint for everyone, or a random paint per detected face.' }),
      el('li', { html: '<b>Add overlays</b> (text, image or looping video logo) and position them in the preview.' }),
      el('li', { html: 'Tune <b>Occlusion</b>, <b>Edge blend</b> and <b>Smoothing</b> in the Display tab to taste.' }),
    ]),
    el('h2', {}, 'Tips'),
    el('ul', {}, [
      el('li', { html: 'Display shortcuts: <b>F</b> full screen · <b>I</b> info/FPS · <b>D</b> mesh debug.' }),
      el('li', { html: 'Use <b>Export</b> to back up your whole kit (paints + settings) and move it to another machine.' }),
    ]),
    diagnosticsSection()
  );
  return el('div', { class: 'help' }, children);
}

function diagnosticsSection() {
  return el('div', {}, [
    el('h2', {}, 'Diagnostics'),
    el('p', { class: 'hint' }, 'Generate a report of the live state (version, face engine, GPU, camera, FPS, faces, recent errors) to check everything works — copy it to send for support.'),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', onclick: runDiagnostics }, 'Run diagnostics'),
      el('button', { class: 'btn ghost', id: 'diagCopy', style: { display: 'none' }, onclick: copyDiag }, 'Copy'),
      el('button', { class: 'btn ghost', id: 'diagDownload', style: { display: 'none' }, onclick: downloadDiag }, 'Download .txt'),
    ]),
    el('textarea', {
      id: 'diagOut',
      rows: 16,
      readonly: true,
      style: { display: 'none', marginTop: '8px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre' },
    }),
  ]);
}

function runDiagnostics() {
  const out = document.getElementById('diagOut');
  out.style.display = '';
  out.value = 'Collecting… (make sure the Display window is open)';
  const p = new Promise((resolve) => {
    awaitingDiag = resolve;
    setTimeout(() => {
      if (awaitingDiag) { awaitingDiag = null; resolve(null); }
    }, 1500);
  });
  bus.post(MSG.DIAG_REQUEST);
  p.then((displayDiag) => {
    diagText = buildReport(displayDiag);
    out.value = diagText;
    document.getElementById('diagCopy').style.display = '';
    document.getElementById('diagDownload').style.display = '';
  });
}

function buildReport(d) {
  const s = state.settings;
  const cfg = window.FT_CONFIG;
  const L = [];
  L.push('FaceTracker diagnostics — ' + new Date().toISOString());
  L.push('');
  L.push('[Control]');
  L.push('version:        ' + ((cfg && cfg.version) || 'web (npm start)'));
  L.push('runtime:        ' + (cfg ? `desktop (${cfg.platform})` : 'browser'));
  L.push('auto-update:    ' + (window.FT_UPDATE ? 'available' : 'not available'));
  L.push('display online: ' + (document.getElementById('statusDot')?.classList.contains('on') ? 'yes' : 'no'));
  L.push('content:        ' + `${state.paints.length} paint(s), ${state.stickers.length} sticker(s), ${state.overlays.length} overlay(s)`);
  L.push('paint mode:     ' + s.paintMode + (s.paintMode === 'single' ? ` (active set: ${s.activePaintId ? 'yes' : 'NO'})` : ''));
  L.push('settings:       ' + `mirror=${s.mirror}, occlusion=${s.occlusion}, edgeOpacity=${s.edgeOpacity}, grad=${s.gradStart}-${s.gradEnd}/h${s.gradHardness}, smoothing=${s.smoothing}, numFaces=${s.numFaces}, opacity=${s.paintOpacity}, colour=${s.colorFilter}, detector=${s.detectorDelegate}`);
  L.push('userAgent:      ' + navigator.userAgent);
  L.push('');
  L.push('[Display]');
  if (!d) {
    L.push('No response from a Display window within 1.5s.');
    L.push('Open the Display (top-right "Open Display") and run diagnostics again.');
  } else {
    L.push('version:        ' + d.version);
    L.push('running:        ' + d.running);
    L.push('face engine:    ' + d.engine);
    L.push('engine module:  ' + d.engineModule);
    L.push('WebGL/GPU:      ' + d.webgl);
    L.push('camera:         ' + d.cameraLabel + ' @ ' + d.resolution + (d.cameraFps ? ` ${d.cameraFps}fps` : ''));
    L.push('detection:      ' + d.fps + ' fps, ' + d.faces + ' face(s) currently tracked');
    L.push('');
    L.push('recent display logs:');
    if (d.recentLogs && d.recentLogs.length) d.recentLogs.forEach((l) => L.push('  ' + l));
    else L.push('  (none)');
  }
  return L.join('\n');
}

function copyDiag() {
  navigator.clipboard?.writeText(diagText).then(
    () => {
      const b = document.getElementById('diagCopy');
      if (b) { b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy'), 1500); }
    },
    () => {}
  );
}

function downloadDiag() {
  const blob = new Blob([diagText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `facetracker-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function updatesSection() {
  const ver = (window.FT_CONFIG && window.FT_CONFIG.version) || '';
  return el('div', {}, [
    el('h2', {}, 'Updates'),
    el('p', { class: 'hint' }, `Installed version: ${ver}`),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', onclick: checkUpdate }, 'Check for updates'),
      el('button', { class: 'btn', id: 'btnInstall', style: { display: 'none' }, onclick: () => window.FT_UPDATE.install() }, 'Restart & install update'),
      el('span', { id: 'updateStatus', class: 'hint', style: { marginLeft: '8px' } }, updateStatusText),
    ]),
  ]);
}

async function checkUpdate() {
  setUpdateStatus('Checking…');
  try {
    const r = await window.FT_UPDATE.check();
    if (!r.ok) setUpdateStatus(r.reason === 'dev' ? 'Updates apply to the installed app only.' : 'Check failed: ' + r.reason);
  } catch {
    setUpdateStatus('Check failed.');
  }
}

function setUpdateStatus(txt, showInstall) {
  updateStatusText = txt;
  const s = document.getElementById('updateStatus');
  if (s) s.textContent = txt;
  if (showInstall !== undefined) {
    const b = document.getElementById('btnInstall');
    if (b) b.style.display = showInstall ? '' : 'none';
  }
}

function applyUpdateEvent(p) {
  const pct = Math.round((p.data && p.data.percent) || 0);
  const map = {
    'checking-for-update': () => setUpdateStatus('Checking…'),
    'update-available': () => setUpdateStatus('Update found — downloading…'),
    'update-not-available': () => setUpdateStatus("You're up to date."),
    'download-progress': () => setUpdateStatus(`Downloading ${pct}%`),
    'update-downloaded': () => setUpdateStatus('Update ready.', true),
    error: () => setUpdateStatus('Update error: ' + (p.data || '')),
  };
  (map[p.event] || (() => {}))();
}

const TABS = { paints: renderPaints, stickers: renderStickers, overlays: renderOverlays, display: renderDisplay, help: renderHelp };

// ===========================================================================
// Actions
// ===========================================================================
function fileInput(accept, multiple, onchange) {
  return el('input', { type: 'file', accept, multiple: multiple || false, style: { display: 'none' }, onchange });
}
function wireDrop(node, onFiles) {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    node.classList.add('drag');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drag'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drag');
    onFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  });
}

async function savePaintBlob(blob, name) {
  const id = store.uid('paint');
  await store.put(STORES.paints, { id, name, blob, createdAt: Date.now(), updatedAt: Date.now() });
  if (!state.settings.activePaintId) await store.saveSettings({ activePaintId: id });
  return id;
}
async function addPaints(e) {
  const files = [...(e.target.files || [])];
  const ids = [];
  for (const f of files) ids.push(await savePaintBlob(f, f.name.replace(/\.[^.]+$/, '')));
  bus.changed(STORES.paints);
  bus.changed(STORES.settings);
  await refresh();
  for (const id of ids) await autoFitPaint(id); // auto-align each uploaded paint
}
function addSamplePaint() {
  buildSamplePaintCanvas({ size: 1024 }).toBlob(async (blob) => {
    const id = await savePaintBlob(blob, 'Sample skull');
    bus.changed(STORES.paints);
    bus.changed(STORES.settings);
    await refresh();
    await autoFitPaint(id);
  }, 'image/png');
}
async function deletePaint(p) {
  await store.del(STORES.paints, p.id);
  const patch = {};
  if (state.settings.activePaintId === p.id) patch.activePaintId = null;
  patch.enabledPaintIds = (state.settings.enabledPaintIds || []).filter((id) => id !== p.id);
  await store.saveSettings(patch);
  bus.changed(STORES.paints);
  bus.changed(STORES.settings);
  await refresh();
}

async function addStickers(e) {
  for (const f of [...(e.target.files || [])]) {
    await store.put(STORES.stickers, {
      id: store.uid('stk'),
      name: f.name.replace(/\.[^.]+$/, ''),
      blob: f,
      anchor: 'forehead',
      scale: 1.5,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      opacity: 1,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  bus.changed(STORES.stickers);
  await refresh();
}
async function deleteSticker(s) {
  await store.del(STORES.stickers, s.id);
  bus.changed(STORES.stickers);
  await refresh();
}

async function addText() {
  await store.put(STORES.overlays, { id: store.uid('ov'), kind: 'text', text: '#SKELFIE', fontSize: 9, color: '#ffffff', bg: 'transparent', bold: true, x: 50, y: 88, rotation: 0, opacity: 1, z: state.overlays.length, enabled: true });
  bus.changed(STORES.overlays);
  await refresh();
}
async function addMediaOverlay(e, kind) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  await store.put(STORES.overlays, { id: store.uid('ov'), kind, blob: f, x: 85, y: 12, widthPct: 18, rotation: 0, opacity: 1, loop: true, z: state.overlays.length, enabled: true });
  bus.changed(STORES.overlays);
  await refresh();
}
async function deleteOverlay(o) {
  await store.del(STORES.overlays, o.id);
  bus.changed(STORES.overlays);
  await refresh();
}
async function moveOverlay(o, dir) {
  const arr = state.overlays;
  const i = arr.findIndex((x) => x.id === o.id);
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  for (let k = 0; k < arr.length; k++) {
    arr[k].z = k;
    await store.put(STORES.overlays, arr[k]);
  }
  bus.changed(STORES.overlays);
  await refresh();
}

async function listCameras() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch {}
  cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  render();
}

// ---- export / import ------------------------------------------------------
async function exportConfig() {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `facetracker-kit-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function importConfig(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const data = JSON.parse(await f.text());
  await store.importAll(data, { merge: false });
  ['paints', 'stickers', 'overlays', 'settings'].forEach((s) => bus.changed(s));
  await refresh();
}

// ===========================================================================
// Render
// ===========================================================================
function render() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  if (overlayPreview) {
    overlayPreview.destroy();
    overlayPreview = null;
  }

  // tab bar
  const tabbar = document.getElementById('tabs');
  tabbar.innerHTML = '';
  for (const key of Object.keys(TABS)) {
    tabbar.append(
      el('button', { class: 'tab' + (state.tab === key ? ' active' : ''), onclick: () => { state.tab = key; render(); } }, key[0].toUpperCase() + key.slice(1))
    );
  }
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.append(TABS[state.tab]());
}

function setStatus(online) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'dot ' + (online ? 'on' : 'off');
  txt.textContent = online ? 'Display online' : 'Display offline';
}

function boot() {
  document.getElementById('openDisplay').onclick = () => window.open('display.html', 'ftDisplay');
  document.getElementById('exportBtn').onclick = exportConfig;
  const imp = document.getElementById('importInput');
  imp.onchange = importConfig;
  document.getElementById('importBtn').onclick = () => imp.click();

  trackPresence(bus, 'display', setStatus);
  navigator.mediaDevices?.enumerateDevices().then((d) => { cameras = d.filter((x) => x.kind === 'videoinput'); }).catch(() => {});

  // Desktop build: show version + listen for auto-update events.
  const v = window.FT_CONFIG && window.FT_CONFIG.version;
  if (v) {
    const brand = document.querySelector('.brand');
    if (brand) brand.insertAdjacentHTML('beforeend', ` <span style="opacity:.5;font-weight:600;font-size:12px">v${v}</span>`);
  }
  if (window.FT_UPDATE) {
    window.FT_UPDATE.onEvent((p) => applyUpdateEvent(p));
  }

  // Receive diagnostics reports from the display.
  bus.on((msg) => {
    if (msg.type === MSG.DIAG_REPORT && awaitingDiag) {
      const resolve = awaitingDiag;
      awaitingDiag = null;
      resolve(msg.diag);
    }
  });

  refresh();
}

boot();
