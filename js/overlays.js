// FaceTracker — overlay layer (text, image and video logos).
// Rendered as plain DOM so text stays crisp and video logos "just work".
// Sizes use container-query units (cqw/cqh) and positions use percentages, so
// the exact same overlay config renders identically in the full-screen display
// and in the control panel's scaled preview.

const isBlobOverlay = (o) => o.kind === 'image' || o.kind === 'video';

export function createOverlayLayer(container) {
  container.classList.add('ft-overlay-layer');
  const items = new Map(); // id -> { el, url, kind }

  function makeEl(o) {
    let el;
    if (o.kind === 'text') {
      el = document.createElement('div');
      el.className = 'ft-ov ft-ov-text';
    } else if (o.kind === 'image') {
      el = document.createElement('img');
      el.className = 'ft-ov ft-ov-image';
      el.decoding = 'async';
    } else if (o.kind === 'video') {
      el = document.createElement('video');
      el.className = 'ft-ov ft-ov-video';
      el.autoplay = true;
      el.loop = o.loop !== false;
      el.muted = true; // required for autoplay
      el.playsInline = true;
    }
    container.appendChild(el);
    return el;
  }

  function applyCommon(el, o, z) {
    el.style.left = (o.x ?? 50) + '%';
    el.style.top = (o.y ?? 50) + '%';
    el.style.transform = `translate(-50%, -50%) rotate(${o.rotation || 0}deg)`;
    el.style.opacity = String(o.opacity ?? 1);
    el.style.zIndex = String(z);
    el.style.display = o.enabled === false ? 'none' : '';
  }

  function updateItem(o, z) {
    let rec = items.get(o.id);
    if (!rec || rec.kind !== o.kind) {
      if (rec) removeItem(o.id);
      rec = { el: makeEl(o), url: null, kind: o.kind };
      items.set(o.id, rec);
    }
    const el = rec.el;

    if (o.kind === 'text') {
      el.textContent = o.text || '';
      el.style.fontFamily = o.fontFamily || 'Inter, system-ui, sans-serif';
      el.style.fontSize = (o.fontSize ?? 8) + 'cqh';
      el.style.fontWeight = o.bold ? '800' : '500';
      el.style.color = o.color || '#ffffff';
      el.style.letterSpacing = (o.letterSpacing ?? 0) + 'em';
      el.style.textAlign = o.align || 'center';
      el.style.lineHeight = '1.1';
      if (o.bg && o.bg !== 'transparent') {
        el.style.background = o.bg;
        el.style.padding = '0.3em 0.6em';
        el.style.borderRadius = (o.radius ?? 0.2) + 'em';
      } else {
        el.style.background = 'transparent';
        el.style.padding = '0';
      }
      el.style.textShadow = o.shadow === false ? 'none' : '0 2px 12px rgba(0,0,0,0.55)';
    } else if (isBlobOverlay(o)) {
      const wantUrl = o.blob instanceof Blob ? o.blob : null;
      // (Re)create object URL only when the blob identity changes.
      if (wantUrl && rec.blobRef !== o.blob) {
        if (rec.url) URL.revokeObjectURL(rec.url);
        rec.url = URL.createObjectURL(o.blob);
        rec.blobRef = o.blob;
        el.src = rec.url;
      } else if (o.src && el.src !== o.src) {
        el.src = o.src;
      }
      el.style.width = (o.widthPct ?? 20) + 'cqw';
      el.style.height = 'auto';
      if (o.kind === 'video') {
        el.loop = o.loop !== false;
        if (el.paused) el.play().catch(() => {});
      }
    }
    applyCommon(el, o, z);
  }

  function removeItem(id) {
    const rec = items.get(id);
    if (!rec) return;
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.el.remove();
    items.delete(id);
  }

  function render(overlays) {
    const list = [...(overlays || [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    const keep = new Set();
    list.forEach((o, i) => {
      keep.add(o.id);
      updateItem(o, o.z ?? i);
    });
    for (const id of [...items.keys()]) if (!keep.has(id)) removeItem(id);
  }

  function destroy() {
    for (const id of [...items.keys()]) removeItem(id);
  }

  return { render, destroy };
}
