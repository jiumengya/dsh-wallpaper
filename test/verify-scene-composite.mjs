// Round-12 verification: the ported composite path in scene-art.js, including
// the particle steady-state approximation. Runs extractSceneArt through a
// worker thread (exactly like index.js does, weAssetsDir included) for every
// rigged scene wallpaper, particle-heavy scenes and a plain-scene fallback
// sample, asserting the output is a decodable image of the scene's projection
// size. Three composites are additionally compared pixel-wise against spike
// references (rigged+particles, particles-only, particles+light shafts).
// Round-13 adds the colorBlendMode regression: 3600720818 authors its rainbow
// lens flare as a black-bodied Screen-blend layer, which without blend support
// paints an opaque black diamond over 11% of the frame.
// Usage: node verify-scene-composite.mjs <spikeCompositeDir>
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const WORKSHOP = "E:/Steam/steamapps/workshop/content/431960";
const WE_ASSETS = "E:/Steam/steamapps/common/wallpaper_engine/assets";
const SPIKE_DIR = process.argv[2] ?? "D:/项目/spike-transparent";
const LIB_DIR = new URL("../pkg/lib/", import.meta.url);
const RIGGED = [
  "3226487183", "3232289987", "3233141951", "3276911872", "3404976219",
  "3409595232", "3425892769", "3474285451", "3538134134", "3571476687",
  "3629379075", "3641860575", "3719111841",
];
// Scene wallpapers whose particle layers (not a puppet rig) drive the
// composite path: 3484246124 has no rig at all, 3600720818 mixes particles
// with plain image layers, 2847178647 stores its main image layer as
// JPEG-in-TEX (free-image format 2) — the composite must decode it, not
// drop the layer and emit bare clearcolor.
const PARTICLE = ["3484246124", "3600720818", "2847178647"];
// JPEG-layer scenes get an additional not-single-color assertion: a
// clearcolor-only composite means the JPEG layer silently failed to decode.
const JPEG_LAYER = new Set(["2847178647"]);
// Scenes whose glow layers are authored with colorBlendMode (Screen flares on
// a black body). 3600720818 is the reported regression; 3044772271 reuses the
// same flare textures but its own art is dark enough that only extraction and
// projection size are asserted for it.
const BLEND = ["3600720818", "3044772271"];
const BLEND_BLACK_ASSERT = new Set(["3600720818"]);
const PLAIN_SAMPLE = ["3354939387"];
// Pixel-diff references produced by spike-transparent/scene-composite.cjs.
const DIFF_REFS = ["3484246124", "3538134134"];
// 3719111841's spike reference predates lightshafts support: the scene's two
// DIRECTDRAW beams now bake in over 32% of the frame, so exact equality is
// gone. The pinned relation is additive-only — beams contribute non-negative
// light, so every pixel must stay >= the reference and a meaningful share of
// the frame must actually be brighter (a silently dropped beam fails).
const SHAFT_REF = "3719111841";
const COMPOSITE_IDS = new Set([...RIGGED, ...PARTICLE, ...BLEND]);

function extractInWorker(pkgPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scene-art-worker.js", LIB_DIR));
    worker.on("message", (msg) => {
      void worker.terminate();
      if (msg?.error) reject(new Error(msg.error));
      else {
        const data = Buffer.isBuffer(msg.data)
          ? msg.data
          : Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
        resolve({ data, contentType: msg.contentType });
      }
    });
    worker.on("error", (error) => {
      void worker.terminate();
      reject(error);
    });
    worker.postMessage({ pkgPath, weAssetsDir: WE_ASSETS });
  });
}

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

// Scene projection size from scene.pkg's scene.json (mirrors scene-art.js parsing).
function projectionOf(pkgPath) {
  const buf = readFileSync(pkgPath);
  let off = 4 + 8;
  const count = buf.readUInt32LE(off);
  off += 4;
  let sceneEntry = null;
  for (let i = 0; i < count; i++) {
    const pathLen = buf.readUInt32LE(off);
    off += 4;
    const p = buf.toString("utf8", off, off + pathLen);
    off += pathLen;
    const offset = buf.readUInt32LE(off);
    off += 4;
    const size = buf.readUInt32LE(off);
    off += 4;
    if (p === "scene.json") sceneEntry = { offset, size };
  }
  if (!sceneEntry) return null;
  const scene = JSON.parse(buf.subarray(off + sceneEntry.offset, off + sceneEntry.offset + sceneEntry.size).toString("utf8"));
  const proj = scene?.general?.orthogonalprojection ?? {};
  const val = (v) => (v && typeof v === "object" ? v.value : v);
  return { w: Math.round(Number(val(proj.width)) || 0), h: Math.round(Number(val(proj.height)) || 0) };
}

let failures = 0;
const outputs = new Map();
const outDir = join(tmpdir(), "dshwp-scene-composite");
mkdirSync(outDir, { recursive: true });
for (const id of [...new Set([...RIGGED, ...PARTICLE, ...PLAIN_SAMPLE, ...BLEND])]) {
  const pkgPath = join(WORKSHOP, id, "scene.pkg");
  if (!existsSync(pkgPath)) {
    console.log(`${id}: SKIP (no scene.pkg)`);
    continue;
  }
  const proj = projectionOf(pkgPath);
  const t0 = Date.now();
  try {
    const art = await extractInWorker(pkgPath);
    const isPng = art.data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    const isJpg = art.data[0] === 0xff && art.data[1] === 0xd8;
    if (!isPng && !isJpg) throw new Error("payload is neither PNG nor JPEG");
    let dims = "jpg";
    if (isPng) {
      const img = decodePng(art.data);
      dims = `${img.w}x${img.h}`;
      outputs.set(id, img);
      if (COMPOSITE_IDS.has(id)) {
        if (dims !== `${proj.w}x${proj.h}`) throw new Error(`composite ${dims} != projection ${proj.w}x${proj.h}`);
        if (img.w < 640 || img.h < 360) throw new Error(`too small: ${dims}`);
      }
      if (JPEG_LAYER.has(id)) {
        // Quantized (bin 16) most-common color must not dominate: a
        // clearcolor-only composite means the JPEG layer failed to decode.
        const bins = new Map();
        for (let p = 0; p < img.rgba.length; p += 4 * 997) {
          const key = (img.rgba[p] >> 4) * 256 + (img.rgba[p + 1] >> 4) * 16 + (img.rgba[p + 2] >> 4);
          bins.set(key, (bins.get(key) ?? 0) + 1);
        }
        const total = Math.ceil(img.rgba.length / (4 * 997));
        const top = Math.max(...bins.values()) / total;
        if (top > 0.5) throw new Error(`single-color composite (${(top * 100).toFixed(1)}% one bin): JPEG layer lost`);
      }
      if (BLEND_BLACK_ASSERT.has(id)) {
        // The Screen-blend flare body must leave the backdrop untouched
        // (screen with black is identity); without blend support it paints
        // an opaque black diamond over 11% of the frame, post-fix ~0%.
        let black = 0, sampled = 0;
        for (let p = 0; p < img.rgba.length; p += 4 * 3) {
          sampled++;
          if (img.rgba[p + 3] > 200 && img.rgba[p] < 30 && img.rgba[p + 1] < 30 && img.rgba[p + 2] < 30) black++;
        }
        const pct = (100 * black) / sampled;
        if (pct > 1) throw new Error(`blend flare painted opaque black (${pct.toFixed(2)}% of frame)`);
      }
    }
    // Keep one composite per scene for visual spot checks.
    writeFileSync(join(outDir, `${id}.${isPng ? "png" : "jpg"}`), art.data);
    const kind = RIGGED.includes(id) ? " [rigged]" : PARTICLE.includes(id) ? " [particle]" : BLEND.includes(id) ? " [blend]" : " [plain]";
    console.log(`${id}: ${art.contentType} ${dims} ${(art.data.length / 1e6).toFixed(1)}MB ${Date.now() - t0}ms${kind}`);
  } catch (error) {
    failures++;
    const kind = RIGGED.includes(id) ? " [rigged]" : PARTICLE.includes(id) ? " [particle]" : BLEND.includes(id) ? " [blend]" : " [plain]";
    console.log(`${id}: FAIL ${error.message} (${Date.now() - t0}ms)${kind}`);
  }
}
console.log(`samples written to ${outDir}`);

// Pixel comparison of the reference composites against the spike originals.
for (const id of DIFF_REFS) {
  const spikePath = join(SPIKE_DIR, `composite-${id}.png`);
  if (!existsSync(spikePath) || !outputs.has(id)) {
    console.log(`${id} diff vs spike: skipped (missing reference or plugin output)`);
    continue;
  }
  const ref = decodePng(readFileSync(spikePath));
  const got = outputs.get(id);
  if (ref.w !== got.w || ref.h !== got.h) {
    console.log(`${id} diff: size mismatch plugin ${got.w}x${got.h} vs spike ${ref.w}x${ref.h}`);
    failures++;
    continue;
  }
  let sum = 0, maxD = 0, n = 0;
  for (let i = 0; i < ref.rgba.length; i += 4) {
    const d = Math.abs(ref.rgba[i] - got.rgba[i]) + Math.abs(ref.rgba[i + 1] - got.rgba[i + 1]) + Math.abs(ref.rgba[i + 2] - got.rgba[i + 2]);
    sum += d;
    if (d > maxD) maxD = d;
    n++;
  }
  const mean = sum / n / 3;
  console.log(`${id} diff vs spike: mean=${mean.toFixed(3)} max=${maxD}`);
  if (mean > 1 || maxD > 8) {
    console.log("  (plugin output diverges from spike reference)");
    failures++;
  } else {
    console.log("  (plugin output matches spike reference)");
  }
}

// Lightshaft reference: the plugin output must equal the pre-beam spike
// composite plus non-negative light. Any darker pixel means the beam pass
// corrupted the base layers; a darkening-free but dark frame means the beams
// silently stopped rendering.
{
  const id = SHAFT_REF;
  const spikePath = join(SPIKE_DIR, `composite-${id}.png`);
  if (existsSync(spikePath) && outputs.has(id)) {
    const ref = decodePng(readFileSync(spikePath));
    const got = outputs.get(id);
    if (ref.w === got.w && ref.h === got.h) {
      let neg = 0, bright = 0;
      for (let i = 0; i < ref.rgba.length; i += 4) {
        const d = (got.rgba[i] - ref.rgba[i]) + (got.rgba[i + 1] - ref.rgba[i + 1]) + (got.rgba[i + 2] - ref.rgba[i + 2]);
        if (d < 0) neg++;
        if (d > 3) bright++;
      }
      const pct = (100 * bright) / (ref.w * ref.h);
      console.log(`${id} lightshafts vs pre-beam spike: darker=${neg} brighter>${3}=${pct.toFixed(2)}%`);
      if (neg > 0) {
        console.log("  (beam pass darkened base-layer pixels)");
        failures++;
      } else if (pct < 5) {
        console.log("  (beams missing: almost no pixel got brighter)");
        failures++;
      } else {
        console.log("  (beams bake in additively over the pre-beam reference)");
      }
    } else {
      console.log(`${id} lightshafts vs pre-beam spike: size mismatch`);
      failures++;
    }
  } else {
    console.log(`${id} lightshafts vs pre-beam spike: skipped (missing reference or plugin output)`);
  }
}

console.log(failures === 0 ? "ALL SCENE-ART CHECKS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
