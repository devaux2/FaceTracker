// FaceTracker — WebGL compositor.
// Draws, onto a transparent canvas layered over the webcam <video>:
//   * per-face paint textures warped across the 468-point face mesh, with
//     depth-based occlusion (no backface culling — depth can't delete the
//     visible face) and a feathered edge so the paint blends into the skin;
//   * anchored sticker quads (drawn on top, no depth).
// The webcam image, colour filter and overlays are handled in the DOM, so this
// module only renders the things that must follow the geometry.

import { FACE_UV, FACE_TRIANGLES, LANDMARK_COUNT } from './facemesh-data.js';
import { STICKER_ANCHORS, LM } from './config.js';

// Depth scale applied to MediaPipe's z (roughly same scale as x). Only relative
// ordering matters; clamped to stay in clip range.
const Z_SCALE = 2.5;

const VERT_TEX = `
attribute vec3 a_pos;
attribute vec2 a_uv;
attribute float a_edge;
uniform vec2 u_uvScale;   // >1 = paint larger on the face
uniform vec2 u_uvOffset;  // shift the paint across the face
uniform float u_uvRot;    // radians
varying vec2 v_uv;
varying float v_edge;
void main() {
  vec2 p = a_uv - 0.5;
  float cs = cos(u_uvRot), sn = sin(u_uvRot);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  p = p / u_uvScale;
  v_uv = p + 0.5 - u_uvOffset;
  v_edge = a_edge;
  gl_Position = vec4(a_pos, 1.0);
}`;

const FRAG_TEX = `
precision mediump float;
varying vec2 v_uv;
varying float v_edge;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform float u_feather; // 0 = hard edge, 1 = full feather
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  // v_edge: 0 at the paint's silhouette -> 1 at the centre. u_feather controls
  // how far the soft band reaches in (0 = hard edge, 1 = gradient across the
  // whole face), giving a solid middle with a tunable soft edge.
  float fade = smoothstep(0.0, max(u_feather, 0.001), v_edge);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha * fade);
}`;

const VERT_FLAT = `
attribute vec3 a_pos;
void main() { gl_Position = vec4(a_pos, 1.0); }`;

const FRAG_FLAT = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
  return p;
}

// Maps normalized video coords -> clip space with object-fit:cover + optional
// mirror (matching the CSS-displayed <video>), carrying depth into clip z.
export function createMapper(W, H, vw, vh, mirror) {
  const scale = Math.max(W / vw, H / vh);
  const dW = vw * scale, dH = vh * scale;
  const offX = (W - dW) / 2, offY = (H - dH) / 2;
  const sx = (2 * dW) / W, ox = (2 * offX) / W - 1;
  const sy = (2 * dH) / H, oy = 1 - (2 * offY) / H;
  const ms = mirror ? -1 : 1;
  return {
    W, H, mirror,
    toClipInto(lm, out, count) {
      for (let i = 0; i < count; i++) {
        out[i * 3] = (ox + lm[i * 3] * sx) * ms;
        out[i * 3 + 1] = oy - lm[i * 3 + 1] * sy;
        let z = lm[i * 3 + 2] * Z_SCALE;
        out[i * 3 + 2] = z < -0.98 ? -0.98 : z > 0.98 ? 0.98 : z;
      }
    },
    toPixel(nx, ny) {
      let px = offX + nx * dW;
      if (mirror) px = W - px;
      return [px, offY + ny * dH];
    },
    pxToClip(px, py) {
      return [(px / W) * 2 - 1, 1 - (py / H) * 2];
    },
  };
}

// Wireframe edge list (debug view).
function buildEdges() {
  const seen = new Set();
  const edges = [];
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const t = [FACE_TRIANGLES[i], FACE_TRIANGLES[i + 1], FACE_TRIANGLES[i + 2]];
    for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = u < v ? u * 100000 + v : v * 100000 + u;
      if (!seen.has(k)) { seen.add(k); edges.push(u, v); }
    }
  }
  return new Uint16Array(edges);
}

// Per-vertex feather weight: 0 on the mesh silhouette, 1 at the deepest interior
// point (normalized graph distance from the boundary loop). The shader turns
// this into a controllable soft-edge gradient.
function buildEdgeWeights() {
  const edgeUse = new Map();
  const adj = Array.from({ length: LANDMARK_COUNT }, () => new Set());
  const key = (a, b) => (a < b ? a * 100000 + b : b * 100000 + a);
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const t = [FACE_TRIANGLES[i], FACE_TRIANGLES[i + 1], FACE_TRIANGLES[i + 2]];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      edgeUse.set(key(a, b), (edgeUse.get(key(a, b)) || 0) + 1);
      adj[a].add(b);
      adj[b].add(a);
    }
  }
  const dist = new Int32Array(LANDMARK_COUNT).fill(-1);
  const queue = [];
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const t = [FACE_TRIANGLES[i], FACE_TRIANGLES[i + 1], FACE_TRIANGLES[i + 2]];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      if (edgeUse.get(key(a, b)) === 1) {
        // boundary edge -> both endpoints are on the silhouette
        for (const v of [a, b]) if (dist[v] !== 0) { dist[v] = 0; queue.push(v); }
      }
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    for (const n of adj[v]) if (dist[n] === -1) { dist[n] = dist[v] + 1; queue.push(n); }
  }
  let maxD = 1;
  for (let i = 0; i < LANDMARK_COUNT; i++) if (dist[i] > maxD) maxD = dist[i];
  const w = new Float32Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const d = dist[i] < 0 ? maxD : dist[i];
    w[i] = d / maxD;
  }
  return w;
}

export function createRenderer(canvas) {
  const opts = { alpha: true, premultipliedAlpha: false, antialias: true, depth: true, desynchronized: true };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) throw new Error('WebGL is not available in this browser.');

  const texProg = program(gl, VERT_TEX, FRAG_TEX);
  const flatProg = program(gl, VERT_FLAT, FRAG_FLAT);
  const loc = {
    tex: {
      pos: gl.getAttribLocation(texProg, 'a_pos'),
      uv: gl.getAttribLocation(texProg, 'a_uv'),
      edge: gl.getAttribLocation(texProg, 'a_edge'),
      sampler: gl.getUniformLocation(texProg, 'u_tex'),
      alpha: gl.getUniformLocation(texProg, 'u_alpha'),
      feather: gl.getUniformLocation(texProg, 'u_feather'),
      uvScale: gl.getUniformLocation(texProg, 'u_uvScale'),
      uvOffset: gl.getUniformLocation(texProg, 'u_uvOffset'),
      uvRot: gl.getUniformLocation(texProg, 'u_uvRot'),
    },
    flat: { pos: gl.getAttribLocation(flatProg, 'a_pos'), color: gl.getUniformLocation(flatProg, 'u_color') },
  };

  // Static buffers.
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, FACE_UV, gl.STATIC_DRAW);

  const edgeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, buildEdgeWeights(), gl.STATIC_DRAW);

  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACE_TRIANGLES, gl.STATIC_DRAW);

  const edges = buildEdges();
  const wireIdxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);

  // Dynamic / quad buffers.
  const posBuf = gl.createBuffer();
  const quadPosBuf = gl.createBuffer();
  const quadUvBuf = gl.createBuffer();
  const quadEdgeBuf = gl.createBuffer();
  const quadIdxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadUvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadEdgeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 1, 1, 1]), gl.STATIC_DRAW);

  const posScratch = new Float32Array(LANDMARK_COUNT * 3);
  const quadScratch = new Float32Array(12); // 4 verts * xyz
  const textures = new Map();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function upsertTexture(id, source, version = 0) {
    const existing = textures.get(id);
    if (existing && existing.version === version) return existing;
    const tex = existing ? existing.tex : gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = source.width || source.videoWidth || 1;
    const h = source.height || source.videoHeight || 1;
    const rec = { tex, aspect: w / h, version };
    textures.set(id, rec);
    return rec;
  }
  const hasTexture = (id) => textures.has(id);
  function deleteTexture(id) {
    const r = textures.get(id);
    if (r) { gl.deleteTexture(r.tex); textures.delete(id); }
  }
  function pruneTextures(keepIds) {
    const keep = new Set(keepIds);
    for (const id of [...textures.keys()]) if (!keep.has(id)) deleteTexture(id);
  }

  function resize(w, h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
  function beginFrame() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function bindMeshAttribs() {
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, posScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.tex.pos);
    gl.vertexAttribPointer(loc.tex.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(loc.tex.uv);
    gl.vertexAttribPointer(loc.tex.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
    gl.enableVertexAttribArray(loc.tex.edge);
    gl.vertexAttribPointer(loc.tex.edge, 1, gl.FLOAT, false, 0, 0);
  }

  function drawFaceTexture(track, mapper, texId, alpha, feather, fit) {
    const rec = textures.get(texId);
    if (!rec) return;
    mapper.toClipInto(track.lm, posScratch, LANDMARK_COUNT);

    gl.useProgram(texProg);
    const sc = fit && fit.scale ? fit.scale : 1;
    gl.uniform2f(loc.tex.uvScale, sc, sc);
    gl.uniform2f(loc.tex.uvOffset, (fit && fit.ox) || 0, (fit && fit.oy) || 0);
    gl.uniform1f(loc.tex.uvRot, (((fit && fit.rot) || 0) * Math.PI) / 180);
    bindMeshAttribs();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.uniform1i(loc.tex.sampler, 0);
    gl.uniform1f(loc.tex.alpha, alpha);
    gl.uniform1f(loc.tex.feather, feather);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, FACE_TRIANGLES.length, gl.UNSIGNED_SHORT, 0);
  }

  function drawWire(track, mapper, color = [0.1, 1.0, 0.6, 0.9]) {
    mapper.toClipInto(track.lm, posScratch, LANDMARK_COUNT);
    gl.useProgram(flatProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, posScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.flat.pos);
    gl.vertexAttribPointer(loc.flat.pos, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(loc.flat.color, color);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIdxBuf);
    gl.drawElements(gl.LINES, edges.length, gl.UNSIGNED_SHORT, 0);
  }

  function drawSticker(track, sticker, mapper) {
    const rec = textures.get(sticker.id);
    if (!rec) return;
    const anchor = STICKER_ANCHORS[sticker.anchor] || STICKER_ANCHORS.face;
    const lm = track.lm;
    const get = (i) => [lm[i * 3], lm[i * 3 + 1]];

    let cx, cy, angle;
    if (anchor.pos.length >= 2) {
      const [ax, ay] = mapper.toPixel(...get(anchor.pos[0]));
      const [bx, by] = mapper.toPixel(...get(anchor.pos[1]));
      cx = (ax + bx) / 2; cy = (ay + by) / 2;
      angle = Math.atan2(by - ay, bx - ax);
    } else {
      [cx, cy] = mapper.toPixel(...get(anchor.pos[0]));
      const [ex, ey] = mapper.toPixel(...get(LM.leftEyeOuter));
      const [fx, fy] = mapper.toPixel(...get(LM.rightEyeOuter));
      angle = Math.atan2(fy - ey, fx - ex);
    }
    const [r0x, r0y] = mapper.toPixel(...get(anchor.scaleRef[0]));
    const [r1x, r1y] = mapper.toPixel(...get(anchor.scaleRef[1]));
    const size = Math.hypot(r1x - r0x, r1y - r0y) * (sticker.scale || 1.5);
    const hw = (size * rec.aspect) / 2, hh = size / 2;
    const rot = angle + ((sticker.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    cx += (sticker.offsetX || 0) * size * cos - (sticker.offsetY || 0) * size * sin;
    cy += (sticker.offsetX || 0) * size * sin + (sticker.offsetY || 0) * size * cos;

    const local = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    for (let i = 0; i < 4; i++) {
      const lx = local[i * 2], ly = local[i * 2 + 1];
      const [clx, cly] = mapper.pxToClip(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
      quadScratch[i * 3] = clx;
      quadScratch[i * 3 + 1] = cly;
      quadScratch[i * 3 + 2] = 0;
    }

    gl.useProgram(texProg);
    // Stickers share the paint shader — reset the per-paint UV transform.
    gl.uniform2f(loc.tex.uvScale, 1, 1);
    gl.uniform2f(loc.tex.uvOffset, 0, 0);
    gl.uniform1f(loc.tex.uvRot, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.tex.pos);
    gl.vertexAttribPointer(loc.tex.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadUvBuf);
    gl.enableVertexAttribArray(loc.tex.uv);
    gl.vertexAttribPointer(loc.tex.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadEdgeBuf);
    gl.enableVertexAttribArray(loc.tex.edge);
    gl.vertexAttribPointer(loc.tex.edge, 1, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.uniform1i(loc.tex.sampler, 0);
    gl.uniform1f(loc.tex.alpha, sticker.opacity ?? 1);
    gl.uniform1f(loc.tex.feather, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdxBuf);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function render({ tracks, mapper, paintFor, getFit, opacity = 1, stickers = [], meshDebug = false, occlusion = true, edgeFeather = 0.45 }) {
    beginFrame();

    // Pass 1: warped face paint. Depth-test gives real self/turn occlusion
    // (nearer triangles win where the mesh folds over itself) but can never
    // delete the visible face. We intentionally do NOT backface-cull.
    if (!meshDebug) {
      if (occlusion) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
      } else {
        gl.disable(gl.DEPTH_TEST);
      }
      for (const track of tracks) {
        const pid = paintFor ? paintFor(track) : null;
        if (pid && textures.has(pid)) drawFaceTexture(track, mapper, pid, opacity, edgeFeather, getFit ? getFit(pid) : null);
      }
    }

    // Pass 2: stickers + debug wireframe always sit on top.
    gl.disable(gl.DEPTH_TEST);
    for (const track of tracks) {
      for (const s of stickers) if (s.enabled !== false && textures.has(s.id)) drawSticker(track, s, mapper);
      if (meshDebug) drawWire(track, mapper);
    }
  }

  return { gl, resize, upsertTexture, hasTexture, deleteTexture, pruneTextures, render, beginFrame };
}
