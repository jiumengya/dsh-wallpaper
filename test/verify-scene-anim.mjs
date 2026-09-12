// Round-14 verification: the browser particle overlay end-to-end. Loads the
// REAL client.js into a Node DOM shim, serves the REAL animation exports
// (extracted through the real scene-art worker) through a fetch shim, then
// runs the real mountBackground → startSceneAnim → drawAnimFrame pipeline
// against a controlled requestAnimationFrame clock. A software 2D-context
// rasterizer (transform stack, bilinear drawImage, source-over/lighter/
// multiply/destination-in) renders the overlay canvas, and the test asserts:
//  - the body art carries ?flat=1 and the overlay layer mounts,
//  - pre-rolled petals are visible at load (starttime pre-simulation),
//  - the canvas repaints the flat art as its base and petals are visible
//    (diff against the art base) and MOVE between two sampled frames,
//  - live coverage is the same order as the baked steady state,
//  - additive sprites never render DARKER than the art base (black-squares
//    regression: `lighter` on a transparent canvas composited the textures'
//    opaque black backgrounds as dark squares over the page),
//  - a particle-less scene falls back to the composite art URL,
//  - switching to a non-scene wallpaper tears the overlay down.
// Usage: node verify-scene-anim.mjs
import { Worker } from "node:worker_threads";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const WORKSHOP = "E:/Steam/steamapps/workshop/content/431960";
const WE_ASSETS = "E:/Steam/steamapps/common/wallpaper_engine/assets";
const LIB_DIR = new URL("../pkg/lib/", import.meta.url);
// The user's live wallpaper (petals, randomframe 4-frame sheet) plus an
// oscillation + additive-blending heavy scene and a particle-less scene.
const ANIM_IDS = ["3013647681", "3719111841"];
const FALLBACK_ID = "3354939387";
const VW = 960;
const VH = 540;

// ── PNG decode/encode (same approach as verify-scene-composite.mjs) ────────

function decodePng(buf) {
  let o = 8;
  let w = 0, h = 0, colorType = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const rgba = Buffer.alloc(w * h * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      if (filter === 1) line[i] = (line[i] + (i < channels ? 0 : line[i - channels])) & 0xff;
      else if (filter === 2) line[i] = (line[i] + prev[i]) & 0xff;
      else if (filter === 3) line[i] = (line[i] + (((i < channels ? 0 : line[i - channels]) + prev[i]) >> 1)) & 0xff;
      else if (filter === 4) {
        const a = i < channels ? 0 : line[i - channels];
        const b = prev[i];
        const c = i < channels ? 0 : prev[i - channels];
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < w; x++) {
      const i = x * channels;
      const j = (y * w + x) * 4;
      if (colorType === 6) { rgba[j] = line[i]; rgba[j + 1] = line[i + 1]; rgba[j + 2] = line[i + 2]; rgba[j + 3] = line[i + 3]; }
      else if (colorType === 2) { rgba[j] = line[i]; rgba[j + 1] = line[i + 1]; rgba[j + 2] = line[i + 2]; rgba[j + 3] = 255; }
      else { rgba[j] = rgba[j + 1] = rgba[j + 2] = line[i]; rgba[j + 3] = 255; }
    }
    line.copy(prev);
  }
  return { rgba, w, h };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode straight-alpha RGBA as PNG. */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── software 2D context (premultiplied buffer, canvas-spec blending) ───────

const mul = (m, t) => [
  m[0] * t[0] + m[2] * t[1],
  m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3],
  m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4],
  m[1] * t[4] + m[3] * t[5] + m[5],
];

const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
};

const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function sampleBilinear(img, fx, fy) {
  const { rgba, w, h } = img;
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const gx = Math.max(0, Math.min(1, fx - x0));
  const gy = Math.max(0, Math.min(1, fy - y0));
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const i00 = (y0 * w + x0) * 4 + c, i10 = (y0 * w + x1) * 4 + c;
    const i01 = (y1 * w + x0) * 4 + c, i11 = (y1 * w + x1) * 4 + c;
    out[c] = rgba[i00] * (1 - gx) * (1 - gy) + rgba[i10] * gx * (1 - gy)
      + rgba[i01] * (1 - gx) * gy + rgba[i11] * gx * gy;
  }
  return out;
}

class FakeCtx {
  /** @param {FakeCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.fillStyle = "#000000";
    this._m = [1, 0, 0, 1, 0, 0];
    this._stack = [];
  }

  setTransform(a, b, c, d, e, f) { this._m = [a, b, c, d, e, f]; }

  transform(a, b, c, d, e, f) { this._m = mul(this._m, [a, b, c, d, e, f]); }

  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }

  rotate(t) { this.transform(Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0); }

  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }

  save() { this._stack.push({ m: this._m, a: this.globalAlpha, o: this.globalCompositeOperation }); }

  restore() {
    const s = this._stack.pop();
    if (s) { this._m = s.m; this.globalAlpha = s.a; this.globalCompositeOperation = s.o; }
  }

  clearRect(x, y, w, h) {
    this._forEachRectPixel(x, y, w, h, (idx) => {
      this.canvas._data.fill(0, idx, idx + 4);
    });
  }

  fillRect(x, y, w, h) {
    const fill = this._fillColor();
    this._forEachRectPixel(x, y, w, h, (idx) => {
      this._blend(idx, fill, 1, this.globalCompositeOperation);
    });
  }

  drawImage(img, ...args) {
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    let dx, dy, dw, dh;
    if (args.length === 4) {
      [dx, dy, dw, dh] = args;
    } else {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    }
    // Resolve the source: FakeImage carries its decoded pixels in `_decoded`,
    // a FakeCanvas must be snapshotted to straight alpha (cached per canvas).
    const src = img._decoded ?? (img instanceof FakeCanvas ? (img._srcCache ??= img.snapshotImg()) : null) ?? img;
    const m = this._m;
    const mi = inv(m);
    const corners = [[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]].map(([x, y]) => applyM(m, x, y));
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const [lx, ly] = applyM(mi, px + 0.5, py + 0.5);
        const u = (lx - dx) / dw;
        const v = (ly - dy) / dh;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const s = sampleBilinear(src, sx + u * sw, sy + v * sh);
        const idx = (py * this.canvas.width + px) * 4;
        this._blend(idx, [s[0], s[1], s[2]], (s[3] / 255) * this.globalAlpha, this.globalCompositeOperation);
      }
    }
  }

  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const si = ((y + yy) * this.canvas.width + (x + xx)) * 4;
        const di = (yy * w + xx) * 4;
        const a = this.canvas._data[si + 3] / 255;
        data[di] = a > 0 ? this.canvas._data[si] / a : 0;
        data[di + 1] = a > 0 ? this.canvas._data[si + 1] / a : 0;
        data[di + 2] = a > 0 ? this.canvas._data[si + 2] / a : 0;
        data[di + 3] = this.canvas._data[si + 3];
      }
    }
    return { data, width: w, height: h };
  }

  _forEachRectPixel(x, y, w, h, fn) {
    const m = this._m;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => applyM(m, px, py));
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) fn((py * this.canvas.width + px) * 4);
    }
  }

  _fillColor() {
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(this.fillStyle));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  }

  /** Blend one straight-RGB source pixel (alpha 0..1) into the premult buffer. */
  _blend(idx, rgb, sa, op) {
    const d = this.canvas._data;
    const db = d[idx + 3] / 255;
    if (op === "source-over") {
      const oa = sa + db * (1 - sa);
      for (let c = 0; c < 3; c++) d[idx + c] = rgb[c] * sa + d[idx + c] * (1 - sa);
      d[idx + 3] = oa * 255;
    } else if (op === "lighter") {
      for (let c = 0; c < 3; c++) d[idx + c] = Math.min(255, rgb[c] * sa + d[idx + c]);
      d[idx + 3] = Math.min(255, sa * 255 + d[idx + 3]);
    } else if (op === "multiply") {
      // αs=1 (fillRect): out_premult = Cs·(1−αb) + αb·Cs·Cb, and the buffer
      // stores Cb premultiplied, so αb·Cs·Cb = Cs·D_premult.
      for (let c = 0; c < 3; c++) d[idx + c] = (rgb[c] * d[idx + c]) / 255 + rgb[c] * (1 - db);
      d[idx + 3] = 255;
    } else if (op === "destination-in") {
      for (let c = 0; c < 3; c++) d[idx + c] = d[idx + c] * sa;
      d[idx + 3] = d[idx + 3] * sa;
    }
  }
}

class FakeCanvas {
  constructor() {
    this._width = 300;
    this._height = 150;
    this._data = new Float64Array(300 * 150 * 4);
    this._ctx = new FakeCtx(this);
    this._srcCache = null;
  }

  get width() { return this._width; }
  get height() { return this._height; }

  /** Assigning either dimension resets the bitmap, like a real canvas. */
  set width(v) { this._resize(Number(v), this._height); }
  set height(v) { this._resize(this._width, Number(v)); }

  _resize(w, h) {
    if (w === this._width && h === this._height) return;
    this._width = Math.max(0, w);
    this._height = Math.max(0, h);
    this._data = new Float64Array(this._width * this._height * 4);
    this._srcCache = null;
  }

  getContext() { return this._ctx; }

  /** Straight-alpha RGBA snapshot. */
  snapshot() {
    const out = Buffer.alloc(this._width * this._height * 4);
    for (let i = 0; i < out.length; i += 4) {
      const a = this._data[i + 3] / 255;
      out[i] = a > 0 ? this._data[i] / a : 0;
      out[i + 1] = a > 0 ? this._data[i + 1] / a : 0;
      out[i + 2] = a > 0 ? this._data[i + 2] / a : 0;
      out[i + 3] = this._data[i + 3];
    }
    return out;
  }

  /** Snapshot as a drawImage source object. */
  snapshotImg() {
    return { rgba: this.snapshot(), w: this._width, h: this._height, width: this._width, height: this._height };
  }
}

// ── DOM / browser shims ────────────────────────────────────────────────────

const elements = new Map();

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.id = "";
    this.style = {
      _vars: new Map(),
      setProperty: (k, v) => this.style._vars.set(k, v),
      removeProperty: (k) => this.style._vars.delete(k),
      getPropertyValue: (k) => this.style._vars.get(k) ?? "",
    };
    // Arrow methods capture the element as `this`, so the set is a closure.
    const classSet = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, f) => { (f === undefined ? !classSet.has(c) : f) ? classSet.add(c) : classSet.delete(c) },
    };
  }

  appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); return child; }

  /** DOM semantics: detach from the parent only — children go with the subtree. */
  remove() {
    const parent = this._parent;
    if (parent) {
      const i = parent.children.indexOf(this);
      if (i >= 0) parent.children.splice(i, 1);
    }
    if (this.id) elements.delete(this.id);
  }
}

class FakeImageElement extends FakeElement {
  constructor() { super("img"); }
}

const registry = { images: new Map() };

class FakeImage {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.onload = null;
    this.onerror = null;
    this._decoded = null;
    this._src = "";
    // NB: assigning `this.src` here would schedule a stale onerror timer that
    // fires after the caller installs its handlers and spuriously rejects.
  }

  set src(url) {
    this._src = url;
    // Full-URL lookup: the registry keys encode the backend's `?flat=1`
    // semantics (flat frame vs composite), which the query distinguishes.
    const hit = registry.images.get(url);
    if (process.env.ANIM_TRACE) console.log("  [Image]", url, hit ? `hit ${hit.w}x${hit.h}` : "MISS");
    if (hit) {
      this._decoded = hit;
      this.width = hit.w;
      this.height = hit.h;
      setTimeout(() => this.onload && this.onload(), 0);
    } else {
      setTimeout(() => this.onerror && this.onerror(), 0);
    }
  }

  get src() { return this._src; }
}

const body = new FakeElement("body");
const head = new FakeElement("head");
body._parent = null;

const documentShim = {
  body,
  head,
  createElement(tag) {
    if (tag === "canvas") return new FakeCanvas();
    if (tag === "img") return new FakeImageElement();
    return new FakeElement(tag);
  },
  getElementById(id) {
    if (id === "dshWpAnim") {
      for (const c of body.children) if (c.id === id) return c;
      return null;
    }
    return elements.get(id) ?? null;
  },
  querySelector() { return null; },
};

// appendChild on body must register id'd children for getElementById("dshWpAnim")
const origAppend = body.appendChild.bind(body);
body.appendChild = (child) => {
  origAppend(child);
  child._parent = body;
  if (child.id) elements.set(child.id, child);
  return child;
};

let simTime = 0;
const rafQueue = [];
function requestAnimationFrame(cb) { rafQueue.push(cb); return rafQueue.length; }
function cancelAnimationFrame() { rafQueue.length = 0; }

function pump(seconds, fps = 30) {
  const step = 1000 / fps;
  const frames = Math.round((seconds * 1000) / step);
  for (let i = 0; i < frames; i++) {
    simTime += step;
    const cbs = rafQueue.splice(0);
    for (const cb of cbs) cb(simTime);
  }
}

// Each FakeImage load costs one ~1ms timer hop; a 10-texture scene loads them
// sequentially, so the settle must cover ~10-20 hops after the fetch chain.
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a condition instead of settling on a fixed delay: under machine load
 * a timer hop costs far more than 1ms and a fixed 150ms window flakes before
 * a many-texture mount finishes its sequential image loads.
 */
const waitFor = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

// ── extraction (real scene-art worker, real exports) ──────────────────────

function extractInWorker(pkgPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scene-art-worker.js", LIB_DIR));
    worker.on("message", (msg) => {
      void worker.terminate();
      if (msg?.error) reject(new Error(msg.error));
      else {
        const wrap = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));
        const textures = (msg.anim?.textures ?? []).map((t) => ({ png: wrap(t.png), frames: t.frames ?? null, blending: t.blending ?? "translucent" }));
        resolve({
          data: wrap(msg.data),
          contentType: msg.contentType,
          anim: msg.anim ? { w: msg.anim.w, h: msg.anim.h, systems: msg.anim.systems, textures } : null,
          flat: msg.flat ? wrap(msg.flat) : null,
        });
      }
    });
    worker.on("error", (error) => { void worker.terminate(); reject(error); });
    worker.postMessage({ pkgPath, weAssetsDir: WE_ASSETS });
  });
}

const exportsById = new Map();
for (const id of [...ANIM_IDS, FALLBACK_ID]) {
  const art = await extractInWorker(join(WORKSHOP, id, "scene.pkg"));
  exportsById.set(id, art);
  console.log(`${id}: composite ${art.data.length}B flat ${art.flat ? art.flat.length + "B" : "null"} anim ${art.anim ? art.anim.systems.length + " systems, " + art.anim.textures.length + " textures" : "null"}`);
}

// ── fetch router (the endpoints the real client hits) ─────────────────────

let currentState = null;
const fetchLog = [];
globalThis.fetch = async (url) => {
  const [path, query = ""] = String(url).split("?");
  fetchLog.push(String(url));
  if (process.env.ANIM_TRACE) console.log("  [fetch]", String(url));
  if (path === "/plugin-wallpaper/state") {
    return { ok: true, status: 200, json: async () => currentState };
  }
  const animMatch = /^\/plugin-wallpaper\/scene-anim\/(\d+)$/.exec(path);
  if (animMatch) {
    const art = exportsById.get(animMatch[1]);
    if (art?.anim) {
      return {
        ok: true, status: 200,
        json: async () => ({
          w: art.anim.w, h: art.anim.h, systems: art.anim.systems,
          textures: art.anim.textures.map((t) => ({ frames: t.frames, blending: t.blending })),
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const texMatch = /^\/plugin-wallpaper\/scene-anim-tex\/(\d+)\/(\d+)$/.exec(path);
  if (texMatch) {
    const art = exportsById.get(texMatch[1]);
    const tex = art?.anim?.textures[Number(texMatch[2])];
    if (tex) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// Image registry: texture atlases plus the scene-art URL space with the
// backend's query semantics — `?flat=1` serves the flat frame when the
// export has one (otherwise the composite), the bare URL serves the composite.
for (const [id, art] of exportsById) {
  art.anim?.textures.forEach((t, i) => {
    registry.images.set(`/plugin-wallpaper/scene-anim-tex/${id}/${i}`, decodePng(t.png));
  });
  const composite = decodePng(art.data);
  registry.images.set(`/plugin-wallpaper/scene-art/${id}?flat=1`, art.flat ? decodePng(art.flat) : composite);
  registry.images.set(`/plugin-wallpaper/scene-art/${id}`, composite);
}

// ── load the REAL client.js ───────────────────────────────────────────────

const clientSource = readFileSync(new URL("../pkg/lib/client.js", import.meta.url), "utf8")
  // Surface errors the boot chain swallows, so a mount failure is loud. The
  // scene-anim fallback path (404 for particle-less scenes) stays silent —
  // the checks below assert its observable behavior directly.
  .replaceAll(".catch(() => {})", ".catch((e) => console.error('SWALLOWED:', e && e.stack ? e.stack : e))");
let clientModule = null;
globalThis.window = {
  __ModuleLoader__: { load: (def) => { clientModule = def.factory((name) => {
    if (name === "react") {
      return {
        createElement: () => null, useState: () => [null, () => {}], useCallback: (f) => f,
        useEffect: () => {}, useRef: () => ({ current: true }), useMemo: (f) => f(),
      };
    }
    return {};
  }) } },
  innerWidth: VW,
  innerHeight: VH,
  devicePixelRatio: 1,
};
globalThis.performance = { now: () => simTime };
globalThis.requestAnimationFrame = requestAnimationFrame;
globalThis.cancelAnimationFrame = cancelAnimationFrame;
globalThis.Image = FakeImage;

const runClient = new Function(
  "window", "document", "fetch", "Image", "requestAnimationFrame", "cancelAnimationFrame", "performance",
  clientSource,
);
runClient(globalThis.window, documentShim, globalThis.fetch, FakeImage, requestAnimationFrame, cancelAnimationFrame, globalThis.performance);
if (!clientModule?.apply) throw new Error("client module did not load");
console.log("client.js loaded, module face:", Object.keys(clientModule).join(", "));

const ctxStub = { slots: { inject: () => {} } };
const artVar = () => body.style._vars.get("--dshWp-art");
const animLayer = () => documentShim.getElementById("dshWpAnim");
const animCanvas = () => animLayer()?.children.find((c) => c instanceof FakeCanvas) ?? null;

// ── 1. live particle mount ────────────────────────────────────────────────

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const ID = "3013647681";
currentState = { id: ID, title: "petals", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${ID}`, poster: `/plugin-wallpaper/preview/${ID}` };
clientModule.apply(ctxStub);
await waitFor(() => !!animLayer());
await settle();

check("art URL carries ?flat=1", artVar() === `url("/plugin-wallpaper/scene-art/${ID}?flat=1")`, String(artVar()));
check("overlay layer mounted", !!animLayer());
const canvas = animCanvas();
check("overlay canvas present", !!canvas);

pump(0.2);
check("overlay canvas sized to viewport", canvas?.width === VW && canvas?.height === VH, canvas ? `${canvas.width}x${canvas.height}` : "none");
// The canvas repaints the flat art as its base every frame (additive sprites
// blend against real scene pixels), so particle presence is measured as the
// diff against a freshly painted art base, not raw alpha.
const art = exportsById.get(ID);
const artBase = paintArtBase(decodePng(art.flat), art.anim);
// Pre-rolled load: the petal system's starttime=3 pre-simulates three seconds
// of emission, so about a third of the pool is mid-life at the first frame —
// a pure emission delay would paint none until starttime + fill elapses.
const frame0 = canvas.snapshot();
const pets0 = countDiffFromBase(frame0, artBase);
check("pre-rolled petals visible at load", pets0 > 300, `${pets0} px over art base`);
pump(1.8);
const frameA = canvas.snapshot();
const petsA = countDiffFromBase(frameA, artBase);
check("petals visible after 2s", petsA > 500, `${petsA} px over art base`);

pump(4);
const frameB = canvas.snapshot();
const petsB = countDiffFromBase(frameB, artBase);
const { diffPixels, meanDiff } = diffFrames(frameA, frameB);
check("petals moved between frames", diffPixels > 400 && meanDiff > 0.5, `${diffPixels} px changed, mean ${meanDiff.toFixed(2)}`);

// Coverage sanity: live particles ≈ baked steady-state particle pixels. The
// baked diff counts projection-resolution pixels (3296×1920); the live overlay
// renders at viewport scale, so scale the baked count by cover² before
// comparing orders of magnitude.
const bakedFull = countBakedParticles(decodePng(art.data), decodePng(art.flat));
const coverScale = Math.max(VW / art.anim.w, VH / art.anim.h);
const baked = Math.round(bakedFull * coverScale * coverScale);
const ratio = petsB / Math.max(1, baked);
check("live coverage within 0.4–2.5x of baked", ratio > 0.4 && ratio < 2.5, `live ${petsB} vs baked ${baked} (x${ratio.toFixed(2)})`);

// ── 2. fallback for a particle-less scene ─────────────────────────────────

currentState = { id: FALLBACK_ID, title: "plain", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${FALLBACK_ID}`, poster: "" };
clientModule.apply(ctxStub);
await waitFor(() => artVar() === `url("/plugin-wallpaper/scene-art/${FALLBACK_ID}")`);
await settle();
check("fallback swaps art to composite", artVar() === `url("/plugin-wallpaper/scene-art/${FALLBACK_ID}")`, String(artVar()));
check("no overlay after fallback", !animLayer());

// ── 3. teardown when a non-scene wallpaper mounts ─────────────────────────

currentState = { id: ID, title: "petals", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${ID}`, poster: "" };
clientModule.apply(ctxStub);
await waitFor(() => !!animLayer());
await settle();
check("overlay re-mounted", !!animLayer());
currentState = { id: "111", title: "plain image", type: "image", mode: "image", src: "/plugin-wallpaper/web/111/img.jpg", poster: "" };
clientModule.apply(ctxStub);
await waitFor(() => !animLayer());
await settle();
check("overlay torn down on image wallpaper", !animLayer());
check("no runaway RAF loop", rafQueue.length <= 1, `${rafQueue.length} queued`);

// ── 4. oscillation + additive scene runs clean ────────────────────────────

const OSC = "3719111841";
currentState = { id: OSC, title: "osc", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${OSC}`, poster: "" };
clientModule.apply(ctxStub);
await waitFor(() => !!animCanvas());
await settle();
const oscCanvas = animCanvas();
check("oscillation scene mounts overlay", !!oscCanvas);
pump(2);
const oscA = oscCanvas.snapshot();
pump(3);
const oscB = oscCanvas.snapshot();
const oscDiff = diffFrames(oscA, oscB);
check("oscillation scene animates", oscDiff.diffPixels > 400, `${oscDiff.diffPixels} px changed`);

// The black-squares regression: this scene's systems are all additive, and
// `lighter` can only ADD light — no canvas pixel may end up meaningfully
// darker than the flat-art base. On a transparent overlay canvas the
// textures' opaque black backgrounds composited as dark squares instead.
const oscArt = exportsById.get(OSC);
const oscBase = paintArtBase(decodePng(oscArt.flat), oscArt.anim);
const darker = countDarkerThanBase(oscB, oscBase);
check("additive sprites never darken the art base", darker <= 20, `${darker} px darker`);

// ── 5. undecodable art drops the art layer so the poster shows ─────────────
// A 200 response with a corrupt body (stale browser cache, truncated write)
// fails CSS background rendering WITHOUT falling through to the poster layer,
// leaving a blank page. The client probes the art URL and drops the art
// layer to `none` on decode failure so the poster layer takes over.
const BAD = "3026487183";
registry.images.delete(`/plugin-wallpaper/scene-art/${BAD}?flat=1`);
registry.images.delete(`/plugin-wallpaper/scene-art/${BAD}`);
currentState = { id: BAD, title: "corrupt", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${BAD}`, poster: "/plugin-wallpaper/preview/x" };
clientModule.apply(ctxStub);
await waitFor(() => artVar() === "none");
await settle();
check("undecodable art drops to none (poster layer shows)", artVar() === "none", String(artVar()));
check("poster layer retained on art failure", documentShim.body.style.getPropertyValue("--dshWp-poster") === 'url("/plugin-wallpaper/preview/x")');

// A fresh mount resets the art variable even after a failure drop.
currentState = { id: ID, title: "petals", type: "scene", mode: "image", src: `/plugin-wallpaper/scene-art/${ID}`, poster: "" };
clientModule.apply(ctxStub);
await waitFor(() => artVar() === `url("/plugin-wallpaper/scene-art/${ID}?flat=1")`);
await settle();
check("next mount restores art URL", artVar() === `url("/plugin-wallpaper/scene-art/${ID}?flat=1")`, String(artVar()));

// ── outputs for visual inspection ─────────────────────────────────────────

const outDir = join(tmpdir(), "dshwp-scene-anim");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${ID}.t2.png`), encodePng(frameA, VW, VH));
writeFileSync(join(outDir, `${ID}.t6.png`), encodePng(frameB, VW, VH));
writeFileSync(join(outDir, `${OSC}.t2.png`), encodePng(oscA, VW, VH));
writeFileSync(join(outDir, `${OSC}.t5.png`), encodePng(oscB, VW, VH));
console.log(`frames written to ${outDir}`);

/**
 * Paint the flat art into a fresh canvas exactly like drawAnimFrame's base
 * pass (identity transform, projection-space cover rect), then snapshot.
 * @param {{ rgba: Buffer, w: number, h: number }} flat Decoded flat frame.
 * @param {{ w: number, h: number }} anim Animation projection dimensions.
 */
function paintArtBase(flat, anim) {
  const cv = new FakeCanvas();
  cv.width = VW;
  cv.height = VH;
  const ctx = cv.getContext();
  const cover = Math.max(VW / anim.w, VH / anim.h);
  const ox = (VW - anim.w * cover) / 2;
  const oy = (VH - anim.h * cover) / 2;
  const img = { ...flat, width: flat.w, height: flat.h };
  ctx.drawImage(img, ox, oy, anim.w * cover, anim.h * cover);
  return cv.snapshot();
}

/** Pixels whose RGB differs from the art base (particle presence). */
function countDiffFromBase(frame, base) {
  let n = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const d = Math.abs(frame[i] - base[i]) + Math.abs(frame[i + 1] - base[i + 1]) + Math.abs(frame[i + 2] - base[i + 2]);
    if (d > 18) n++;
  }
  return n;
}

/** Pixels rendered DARKER than the art base (additive must never darken). */
function countDarkerThanBase(frame, base) {
  let n = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const d = (base[i] - frame[i]) + (base[i + 1] - frame[i + 1]) + (base[i + 2] - frame[i + 2]);
    if (d > 24) n++;
  }
  return n;
}

function diffFrames(a, b) {
  let diffPixels = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
    if (d > 12) diffPixels++;
    sum += d / 4;
  }
  return { diffPixels, meanDiff: sum / (a.length / 4) };
}

function countBakedParticles(comp, flat) {
  if (comp.w !== flat.w || comp.h !== flat.h) return 0;
  let n = 0;
  for (let i = 0; i < comp.rgba.length; i += 4) {
    const d = Math.abs(comp.rgba[i] - flat.rgba[i]) + Math.abs(comp.rgba[i + 1] - flat.rgba[i + 1]) + Math.abs(comp.rgba[i + 2] - flat.rgba[i + 2]);
    if (d > 24) n++;
  }
  return n;
}

console.log(failures === 0 ? "ALL SCENE-ANIM CHECKS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
