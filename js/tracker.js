// FaceTracker — face detection + lightweight multi-face tracking.
// Wraps MediaPipe FaceLandmarker and adds:
//   * stable per-face IDs across frames (greedy nearest-centroid matching), so
//     each face keeps the same paint and we can smooth it over time;
//   * temporal smoothing (EMA) to kill landmark jitter;
//   * brief persistence across dropped detection frames to avoid flicker.

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

export class FaceTracks {
  constructor({ smoothing = 0.5, matchDist = 0.14, keepFrames = 3 } = {}) {
    this.setSmoothing(smoothing);
    this.matchDist = matchDist;
    this.keepFrames = keepFrames; // hold a lost face this many frames
    this.tracks = new Map(); // id -> track
    this._nextId = 1;
  }

  setSmoothing(s) {
    // s: 0 (raw) .. ~0.95 (very smooth). alpha is the weight of new data.
    this.alpha = Math.min(1, Math.max(0.04, 1 - s));
  }

  _centroid(lmFlat, n) {
    let x = 0, y = 0, k = 0;
    for (const i of CENTROID_PTS) {
      if (i < n) {
        x += lmFlat[i * 2];
        y += lmFlat[i * 2 + 1];
        k++;
      }
    }
    return k ? [x / k, y / k] : [0.5, 0.5];
  }

  // faceLandmarks: Array<Array<{x,y,z}>> from MediaPipe (normalized 0..1).
  // Returns active tracks: { id, lm: Float32Array(n*2), n, missed, age }.
  update(faceLandmarks) {
    const dets = (faceLandmarks || []).map((pts) => {
      const n = pts.length;
      const flat = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        flat[i * 2] = pts[i].x;
        flat[i * 2 + 1] = pts[i].y;
      }
      return { flat, n, c: this._centroid(flat, n) };
    });

    // Build candidate pairs and assign greedily by ascending distance.
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
      this._smoothInto(trackList[p.ti], dets[p.di]);
    }

    // New tracks for unmatched detections.
    for (let di = 0; di < dets.length; di++) {
      if (detUsed[di]) continue;
      const id = this._nextId++;
      this.tracks.set(id, {
        id,
        lm: dets[di].flat.slice(),
        n: dets[di].n,
        c: dets[di].c,
        missed: 0,
        age: 1,
      });
    }

    // Age / retire unmatched tracks.
    for (let ti = 0; ti < trackList.length; ti++) {
      if (trackUsed[ti]) continue;
      const t = trackList[ti];
      t.missed++;
      if (t.missed > this.keepFrames) this.tracks.delete(t.id);
    }

    // Render anything seen recently (matched this frame -> missed 0).
    return [...this.tracks.values()].filter((t) => t.missed <= this.keepFrames);
  }

  _smoothInto(track, det) {
    const a = this.alpha;
    const lm = track.lm;
    if (track.n !== det.n) {
      track.lm = det.flat.slice();
      track.n = det.n;
    } else {
      for (let i = 0; i < lm.length; i++) lm[i] += (det.flat[i] - lm[i]) * a;
    }
    track.c = det.c;
    track.missed = 0;
    track.age++;
  }

  reset() {
    this.tracks.clear();
  }
}
