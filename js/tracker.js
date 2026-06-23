// FaceTracker — face detection + lightweight multi-face tracking.
// Wraps MediaPipe FaceLandmarker and adds:
//   * stable per-face IDs across frames (greedy nearest-centroid matching), so
//     each face keeps the same paint and we can filter it over time;
//   * One-Euro filtering per landmark (incl. depth) — strong smoothing when a
//     face is still, low lag when it moves, which kills the jitter without the
//     "swimming" lag of a plain moving average;
//   * brief persistence across dropped detection frames to avoid flicker.
// Landmarks are stored interleaved as x,y,z (stride 3) so the renderer can use
// depth for occlusion.

import { MEDIAPIPE, LM } from './config.js';

export async function loadFaceLandmarker({ numFaces = 5, delegate = 'GPU' } = {}) {
  const vision = await import(/* @vite-ignore */ MEDIAPIPE.module);
  const { FaceLandmarker, FilesetResolver } = vision;
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MEDIAPIPE.model, delegate },
    runningMode: 'VIDEO',
    numFaces,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
  return landmarker;
}

const CENTROID_PTS = [LM.noseTip, LM.leftEyeOuter, LM.rightEyeOuter];

// One-Euro filter over a flat array of values, each with its own state.
class OneEuro {
  constructor(size, minCutoff, beta, dCutoff = 1) {
    this.x = new Float32Array(size);
    this.dx = new Float32Array(size);
    this.has = false;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
  setParams(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reinit(input) {
    this.x.set(input);
    this.dx.fill(0);
    this.has = true;
    return this.x;
  }
  filter(input, dt) {
    if (!this.has) return this.reinit(input);
    const aD = OneEuro.alpha(this.dCutoff, dt);
    for (let i = 0; i < input.length; i++) {
      const dx = (input[i] - this.x[i]) / dt;
      const edx = this.dx[i] + aD * (dx - this.dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(edx);
      const a = OneEuro.alpha(cutoff, dt);
      this.x[i] = this.x[i] + a * (input[i] - this.x[i]);
      this.dx[i] = edx;
    }
    return this.x;
  }
}

export class FaceTracks {
  constructor({ smoothing = 0.4, matchDist = 0.14, keepFrames = 3 } = {}) {
    this.matchDist = matchDist;
    this.keepFrames = keepFrames;
    this.tracks = new Map(); // id -> track
    this._nextId = 1;
    this._lastNow = 0;
    this.setSmoothing(smoothing);
  }

  setSmoothing(s) {
    s = Math.min(0.95, Math.max(0, s));
    // One-Euro: minCutoff sets how much jitter is damped when still; beta sets
    // how quickly it tracks motion (high beta = little lag while moving). These
    // are tuned to feel responsive — raise smoothing only if it looks jittery.
    this.minCutoff = 1.0 + (1 - s) * 6.0; // s=0 -> 7 (very snappy), s=0.95 -> ~1.3
    this.beta = 0.05 + (1 - s) * 0.7; // strong motion lead so it doesn't drag
    for (const t of this.tracks.values()) t.filt.setParams(this.minCutoff, this.beta);
  }

  _centroid(flat, n) {
    let x = 0, y = 0, k = 0;
    for (const i of CENTROID_PTS) {
      if (i < n) {
        x += flat[i * 3];
        y += flat[i * 3 + 1];
        k++;
      }
    }
    return k ? [x / k, y / k] : [0.5, 0.5];
  }

  // faceLandmarks: Array<Array<{x,y,z}>> (normalized). now: ms timestamp.
  // Returns active tracks: { id, lm: Float32Array(n*3), n, missed, age }.
  update(faceLandmarks, now) {
    if (!now) now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let dt = (now - this._lastNow) / 1000;
    this._lastNow = now;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60; // first frame / big hitch guard

    const dets = (faceLandmarks || []).map((pts) => {
      const n = pts.length;
      const flat = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        flat[i * 3] = pts[i].x;
        flat[i * 3 + 1] = pts[i].y;
        flat[i * 3 + 2] = pts[i].z || 0;
      }
      return { flat, n, c: this._centroid(flat, n) };
    });

    const trackList = [...this.tracks.values()];
    const pairs = [];
    for (let di = 0; di < dets.length; di++) {
      for (let ti = 0; ti < trackList.length; ti++) {
        const dx = dets[di].c[0] - trackList[ti].c[0];
        const dy = dets[di].c[1] - trackList[ti].c[1];
        pairs.push({ di, ti, d: Math.hypot(dx, dy) });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const detUsed = new Array(dets.length).fill(false);
    const trackUsed = new Array(trackList.length).fill(false);

    for (const p of pairs) {
      if (p.d > this.matchDist) break;
      if (detUsed[p.di] || trackUsed[p.ti]) continue;
      detUsed[p.di] = true;
      trackUsed[p.ti] = true;
      const t = trackList[p.ti];
      const det = dets[p.di];
      if (t.n !== det.n) {
        t.filt = new OneEuro(det.n * 3, this.minCutoff, this.beta);
        t.lm = t.filt.reinit(det.flat);
        t.n = det.n;
      } else {
        t.lm = t.filt.filter(det.flat, dt);
      }
      t.c = det.c;
      t.missed = 0;
      t.age++;
    }

    for (let di = 0; di < dets.length; di++) {
      if (detUsed[di]) continue;
      const det = dets[di];
      const id = this._nextId++;
      const filt = new OneEuro(det.n * 3, this.minCutoff, this.beta);
      this.tracks.set(id, { id, filt, lm: filt.reinit(det.flat), n: det.n, c: det.c, missed: 0, age: 1 });
    }

    for (let ti = 0; ti < trackList.length; ti++) {
      if (trackUsed[ti]) continue;
      const t = trackList[ti];
      t.missed++;
      if (t.missed > this.keepFrames) this.tracks.delete(t.id);
    }

    return [...this.tracks.values()].filter((t) => t.missed <= this.keepFrames);
  }

  reset() {
    this.tracks.clear();
  }
}
