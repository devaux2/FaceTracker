// FaceTracker — paint template generator.
// Renders the face-mesh UV layout to a PNG that designers paint on. Whatever is
// drawn at a given spot on the template lands at the matching spot on the face,
// because the display warps the image through the same UV coordinates.

import { FACE_UV, FACE_TRIANGLES } from './facemesh-data.js';
import { LM } from './config.js';

const LABELS = [
  [LM.foreheadTop, 'forehead'],
  [LM.leftEyeOuter, 'eye'],
  [LM.rightEyeOuter, 'eye'],
  [LM.noseTip, 'nose'],
  [LM.mouthLeft, 'mouth'],
  [LM.chin, 'chin'],
  [LM.faceLeft, 'cheek'],
  [LM.faceRight, 'cheek'],
];

export function buildTemplateCanvas({ size = 1024, guide = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const ux = (i) => FACE_UV[i * 2] * size;
  const uy = (i) => FACE_UV[i * 2 + 1] * size;

  if (guide) {
    // Faint backdrop so the layout is visible while painting.
    ctx.fillStyle = 'rgba(245,246,250,1)';
    ctx.fillRect(0, 0, size, size);

    // Mesh wireframe.
    ctx.strokeStyle = 'rgba(40,60,120,0.22)';
    ctx.lineWidth = Math.max(1, size / 1024);
    ctx.beginPath();
    for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
      const a = FACE_TRIANGLES[i], b = FACE_TRIANGLES[i + 1], c = FACE_TRIANGLES[i + 2];
      ctx.moveTo(ux(a), uy(a));
      ctx.lineTo(ux(b), uy(b));
      ctx.lineTo(ux(c), uy(c));
      ctx.closePath();
    }
    ctx.stroke();

    // Feature labels.
    ctx.fillStyle = 'rgba(20,30,70,0.85)';
    ctx.font = `600 ${Math.round(size / 42)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const [idx, label] of LABELS) {
      const x = ux(idx), y = uy(idx);
      ctx.beginPath();
      ctx.arc(x, y, size / 220, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(label, x, y - size / 90);
    }

    // Header / footer hints.
    ctx.fillStyle = 'rgba(20,30,70,0.55)';
    ctx.font = `700 ${Math.round(size / 34)}px Inter, system-ui, sans-serif`;
    ctx.fillText('FaceTracker paint template', size / 2, size / 22);
    ctx.font = `500 ${Math.round(size / 52)}px Inter, system-ui, sans-serif`;
    ctx.fillText('Paint on a new layer, then export a transparent PNG (hide this guide).', size / 2, size - size / 28);
  }

  return canvas;
}

// A ready-made starter paint: a simple skull, drawn on the UV layout so it
// warps correctly onto faces. Lets users see the effect before authoring.
export function buildSamplePaintCanvas({ size = 1024 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const ux = (i) => FACE_UV[i * 2] * size;
  const uy = (i) => FACE_UV[i * 2 + 1] * size;
  const eyeW = ux(LM.rightEyeOuter) - ux(LM.leftEyeOuter);

  // White face base from the mesh triangles.
  ctx.fillStyle = 'rgba(248,248,250,0.96)';
  ctx.beginPath();
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const a = FACE_TRIANGLES[i], b = FACE_TRIANGLES[i + 1], c = FACE_TRIANGLES[i + 2];
    ctx.moveTo(ux(a), uy(a));
    ctx.lineTo(ux(b), uy(b));
    ctx.lineTo(ux(c), uy(c));
    ctx.closePath();
  }
  ctx.fill();

  ctx.fillStyle = '#0a0a0a';
  // Eye sockets.
  const eye = (outer, inner) => {
    const cx = (ux(outer) + ux(inner)) / 2;
    const cy = (uy(outer) + uy(inner)) / 2;
    const r = Math.abs(ux(outer) - ux(inner)) * 0.95;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.1, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  eye(LM.leftEyeOuter, LM.leftEyeInner);
  eye(LM.rightEyeOuter, LM.rightEyeInner);

  // Nose cavity (inverted triangle).
  const nx = ux(LM.noseTip);
  const nTop = uy(LM.noseBridge) + (uy(LM.noseTip) - uy(LM.noseBridge)) * 0.45;
  const nBot = uy(LM.noseTip) + eyeW * 0.05;
  const nw = eyeW * 0.11;
  ctx.beginPath();
  ctx.moveTo(nx - nw, nBot);
  ctx.lineTo(nx + nw, nBot);
  ctx.lineTo(nx, nTop);
  ctx.closePath();
  ctx.fill();

  // Teeth grin across the mouth.
  const mL = ux(LM.mouthLeft), mR = ux(LM.mouthRight);
  const mY = (uy(LM.mouthTop) + uy(LM.mouthBottom)) / 2;
  const mH = (mR - mL) * 0.42;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(mL, mY - mH / 2, mR - mL, mH);
  ctx.strokeStyle = 'rgba(248,248,250,0.96)';
  ctx.lineWidth = Math.max(2, size / 230);
  ctx.beginPath();
  ctx.moveTo(mL, mY);
  ctx.lineTo(mR, mY); // lip line
  const teeth = 6;
  for (let i = 1; i < teeth; i++) {
    const x = mL + ((mR - mL) * i) / teeth;
    ctx.moveTo(x, mY - mH / 2);
    ctx.lineTo(x, mY + mH / 2);
  }
  ctx.stroke();

  return canvas;
}

export function downloadCanvas(canvas, filename = 'face-template.png') {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}
