// FaceTracker — WebGL compositor.
// Draws, onto a transparent canvas layered over the webcam <video>:
//   * per-face paint textures warped across the 468-point face mesh, and
//   * anchored sticker quads.
// The webcam image, colour filter and overlays are handled in the DOM, so this
// module only ever renders the things that must follow the geometry — which is
// exactly the part that needs the GPU.

import { FACE_UV, FACE_TRIANGLES, LANDMARK_COUNT } from './facemesh-data.js';
import { STICKER_ANCHORS, LM } from './config.js';

const VERT_TEX = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_TEX = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}`;

const VERT_FLAT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG_FLAT = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// Maps normalized video coords -> WebGL clip space with object-fit:cover and
// optional horizontal mirror, matching the CSS-displayed <video>.
export function createMapper(W, H, vw, vh, mirror) {
  const scale = Math.max(W / vw, H / vh);
  const dW = vw * scale;
  const dH = vh * scale;
  const offX = (W - dW) / 2;
  const offY = (H - dH) / 2;
  const sx = (2 * dW) / W;
  const ox = (2 * offX) / W - 1;
  const sy = (2 * dH) / H;
  const oy = 1 - (2 * offY) / H;
  const ms = mirror ? -1 : 1;
  return {
    W, H, mirror,
    toClipInto(lm, out, count) {
      for (let i = 0; i < count; i++) {
        out[i * 2] = (ox + lm[i * 2] * sx) * ms;
        out[i * 2 + 1] = oy - lm[i * 2 + 1] * sy;
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

// Unique edge list for the wireframe debug view (built once).
function buildEdges() {
  const seen = new Set();
  const edges = [];
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const a = FACE_TRIANGLES[i], b = FACE_TRIANGLES[i + 1], c = FACE_TRIANGLES[i + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? u * 100000 + v : v * 100000 + u;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(u, v);
      }
    }
  }
  return new Uint16Array(edges);
}

export function createRenderer(canvas) {
  const opts = { alpha: true, premultipliedAlpha: false, antialias: true, desynchronized: true };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) throw new Error('WebGL is not available in this browser.');

  const texProg = program(gl, VERT_TEX, FRAG_TEX);
  const flatProg = program(gl, VERT_FLAT, FRAG_FLAT);

  const loc = {
    tex: {
      pos: gl.getAttribLocation(texProg, 'a_pos'),
      uv: gl.getAttribLocation(texProg, 'a_uv'),
      sampler: gl.getUniformLocation(texProg, 'u_tex'),
      alpha: gl.getUniformLocation(texProg, 'u_alpha'),
    },
    flat: {
      pos: gl.getAttribLocation(flatProg, 'a_pos'),
      color: gl.getUniformLocation(flatProg, 'u_color'),
    },
  };

  // Static buffers.
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, FACE_UV, gl.STATIC_DRAW);

  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACE_TRIANGLES, gl.STATIC_DRAW);

  const edges = buildEdges();
  const edgeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);

  // Dynamic buffers.
  const posBuf = gl.createBuffer();
  const quadPosBuf = gl.createBuffer();
  const quadUvBuf = gl.createBuffer();
  const quadIdxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadUvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);

  const posScratch = new Float32Array(LANDMARK_COUNT * 2);
  const quadScratch = new Float32Array(8);
  const textures = new Map(); // id -> { tex, aspect, version }

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
    const rec = textures.get(id);
    if (rec) {
      gl.deleteTexture(rec.tex);
      textures.delete(id);
    }
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
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function drawFaceTexture(track, mapper, texId, alpha) {
    const rec = textures.get(texId);
    if (!rec) return;
    mapper.toClipInto(track.lm, posScratch, LANDMARK_COUNT);

    gl.useProgram(texProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, posScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.tex.pos);
    gl.vertexAttribPointer(loc.tex.pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(loc.tex.uv);
    gl.vertexAttribPointer(loc.tex.uv, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.uniform1i(loc.tex.sampler, 0);
    gl.uniform1f(loc.tex.alpha, alpha);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, FACE_TRIANGLES.length, gl.UNSIGNED_SHORT, 0);
  }

  function drawWire(track, mapper, color = [0.1, 1.0, 0.6, 0.9]) {
    mapper.toClipInto(track.lm, posScratch, LANDMARK_COUNT);
    gl.useProgram(flatProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, posScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.flat.pos);
    gl.vertexAttribPointer(loc.flat.pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(loc.flat.color, color);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuf);
    gl.drawElements(gl.LINES, edges.length, gl.UNSIGNED_SHORT, 0);
  }

  function drawSticker(track, sticker, mapper, alpha) {
    const rec = textures.get(sticker.id);
    if (!rec) return;
    const anchor = STICKER_ANCHORS[sticker.anchor] || STICKER_ANCHORS.face;
    const lm = track.lm;
    const get = (i) => [lm[i * 2], lm[i * 2 + 1]];

    // Center + angle from the anchor landmarks.
    let cx, cy, angle;
    if (anchor.pos.length >= 2) {
      const [ax, ay] = mapper.toPixel(...get(anchor.pos[0]));
      const [bx, by] = mapper.toPixel(...get(anchor.pos[1]));
      cx = (ax + bx) / 2;
      cy = (ay + by) / 2;
      angle = Math.atan2(by - ay, bx - ax);
    } else {
      [cx, cy] = mapper.toPixel(...get(anchor.pos[0]));
      const [ex, ey] = mapper.toPixel(...get(LM.leftEyeOuter));
      const [fx, fy] = mapper.toPixel(...get(LM.rightEyeOuter));
      angle = Math.atan2(fy - ey, fx - ex);
    }

    // Base size from the reference landmark distance.
    const [r0x, r0y] = mapper.toPixel(...get(anchor.scaleRef[0]));
    const [r1x, r1y] = mapper.toPixel(...get(anchor.scaleRef[1]));
    const base = Math.hypot(r1x - r0x, r1y - r0y);
    const size = base * (sticker.scale || 1.5);
    const hw = (size * rec.aspect) / 2;
    const hh = size / 2;

    const rot = angle + ((sticker.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    cx += (sticker.offsetX || 0) * size * cos - (sticker.offsetY || 0) * size * sin;
    cy += (sticker.offsetX || 0) * size * sin + (sticker.offsetY || 0) * size * cos;

    const local = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    for (let i = 0; i < 4; i++) {
      const lx = local[i * 2];
      const ly = local[i * 2 + 1];
      const px = cx + lx * cos - ly * sin;
      const py = cy + lx * sin + ly * cos;
      const [clx, cly] = mapper.pxToClip(px, py);
      quadScratch[i * 2] = clx;
      quadScratch[i * 2 + 1] = cly;
    }

    gl.useProgram(texProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.tex.pos);
    gl.vertexAttribPointer(loc.tex.pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadUvBuf);
    gl.enableVertexAttribArray(loc.tex.uv);
    gl.vertexAttribPointer(loc.tex.uv, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.uniform1i(loc.tex.sampler, 0);
    gl.uniform1f(loc.tex.alpha, alpha * (sticker.opacity ?? 1));

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdxBuf);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // High-level per-frame entry point.
  function render({ tracks, mapper, paintFor, opacity = 1, stickers = [], meshDebug = false }) {
    beginFrame();
    for (const track of tracks) {
      if (meshDebug) {
        drawWire(track, mapper);
      } else {
        const pid = paintFor ? paintFor(track) : null;
        if (pid && textures.has(pid)) drawFaceTexture(track, mapper, pid, opacity);
      }
      for (const s of stickers) {
        // Stickers carry their own opacity; don't dim them by the paint opacity.
        if (s.enabled !== false && textures.has(s.id)) drawSticker(track, s, mapper, 1);
      }
    }
  }

  return {
    gl,
    resize,
    upsertTexture,
    hasTexture,
    deleteTexture,
    pruneTextures,
    render,
    drawFaceTexture,
    drawSticker,
    drawWire,
    beginFrame,
  };
}
