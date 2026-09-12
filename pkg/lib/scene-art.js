/**
 * Extract the main art of a Wallpaper Engine scene wallpaper.
 *
 * Scene wallpapers ship their assets inside a proprietary `scene.pkg`
 * container (PKGV0016–PKGV0024). Wallpaper Engine renders them live; a static
 * app background approximates the frame in one of two ways:
 *
 * - Character wallpapers rig their layers onto a puppet skeleton: scene.json
 *   objects name a `puppet` MDL model or an `attachment` point in the parent's
 *   skeleton. `compositeScene` rasterizes every visible layer — background
 *   card, skinned puppet meshes, attachment-anchored hair/cloth cards — onto
 *   the scene's orthogonal projection canvas.
 * - Particle objects (falling petals, snow, embers, light shafts, matrix
 *   rain…) are approximated at their emission steady state: normalized ages
 *   are uniform in [0,1], operator state is an absolute function of that age,
 *   and position integrates analytically (ballistic + drag, vortex, random
 *   phase oscillation), so one random sample per live particle reproduces the
 *   live frame without stepping a clock. Sprite-sheet textures (TEXS frame
 *   tables) pick the frame for the sampled phase.
 * - Everything else falls back to the largest visible image layer, resolved
 *   through the wallpaper's own object chain (scene.json → model → material →
 *   first texture of the first pass) and decoded from its `.tex` entry
 *   (JPEG/PNG payload or GPU-compressed RGBA8888 / DXT1 / DXT3 / DXT5 /
 *   RG88 / R8, optionally LZ4-block compressed).
 *
 * Both paths run inside `scene-art-worker.js` so multi-second decodes never
 * stall the backend event loop.
 * @module @deepseek-ai/dsh-wallpaper/scene-art
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodeJpeg } from './jpeg-decoder.js'

/** TEX `format` field values this module can decode. */
const TEX_FORMATS = { 0: 'RGBA8888', 4: 'DXT5', 6: 'DXT3', 7: 'DXT1', 8: 'RG88', 9: 'R8' }

/** TEX `imageFormat` free-image values that are served as-is. */
const DIRECT_IMAGE_FORMATS = new Set([2 /* JPEG */, 13 /* PNG */])

/** Minimum resolution for an output to count as background art. */
const MIN_ART_WIDTH = 640
const MIN_ART_HEIGHT = 360

/** Rasterized-pixel budget for one composite, in multiples of the canvas. */
const MAX_COMPOSITE_OVERDRAW = 24

/** Total particle sprites one composite may stamp (cost cap). */
const MAX_PARTICLE_SPRITES = 9000

/**
 * Extract the main art of a scene wallpaper.
 * @param {string} pkgPath Absolute path to the wallpaper's scene.pkg.
 * @param {string} [weAssetsDir] Wallpaper Engine `assets` directory; particle
 *   materials may reference shared textures that live only there.
 * @returns {Promise<{ data: Buffer, contentType: string, anim: object | null, flat: Buffer | null, videos: object | null }>}
 *   Encoded image (composite PNG, JPEG passthrough or decoded PNG) plus, when
 *   the composite carries usable particle systems, the animation export
 *   ({ w, h, systems, textures }; see exportAnimSpec) and the flat art frame
 *   (image layers without the baked steady-state particles, for the browser's
 *   live particle overlay). MP4 video layers export as `videos`
 *   ({ w, h, videos } with per-layer matrix, quad size, opacity, colorkey,
 *   colorBlendMode and MP4 bytes; the composite decodes them as no pixels).
 *   Single-layer fallbacks carry `anim: null`, `flat: null` and `videos: null`.
 * @throws {Error} When the container, texture chain or compression is
 *   unsupported, or the resolved texture is too small to be background art.
 */
export async function extractSceneArt(pkgPath, weAssetsDir = '') {
  const buf = fs.readFileSync(pkgPath)
  const pkg = parsePkg(buf)
  const readEntry = (entry) => buf.subarray(pkg.dataBase + entry.offset, pkg.dataBase + entry.offset + entry.size)
  // Deterministic per-wallpaper sampling: the workshop id seeds the RNG.
  const id = Number(path.basename(path.dirname(pkgPath)))
  const composite = compositeScene(pkg, readEntry, weAssetsDir, (0x9e3779b9 ^ id) || 1)
  if (composite) return composite
  const resolved = resolveBackgroundTex(pkg, readEntry)
  if (!resolved) throw new Error('scene.pkg contains no texture')
  const texBuf = readEntry(resolved.entry)
  const tex = parseTex(texBuf)
  if (tex.w < MIN_ART_WIDTH || tex.h < MIN_ART_HEIGHT) {
    throw new Error(`resolved texture ${tex.w}x${tex.h} is too small for background art`)
  }
  const mipData = texBuf.subarray(tex.dataOffset, tex.dataOffset + tex.byteCount)
  if (DIRECT_IMAGE_FORMATS.has(tex.imageFormat) && !tex.lz4) {
    return { data: Buffer.from(mipData), contentType: tex.imageFormat === 13 ? 'image/png' : 'image/jpeg', anim: null, flat: null, videos: null }
  }
  const raw = tex.lz4 ? lz4Decode(mipData, tex.decomp) : mipData
  let rgba
  if (tex.format === 0) rgba = decodeRGBA(raw, tex.w, tex.h)
  else if (tex.format === 7) rgba = decodeDXT1(raw, tex.w, tex.h)
  else if (tex.format === 6) rgba = decodeDXT3(raw, tex.w, tex.h)
  else if (tex.format === 4) rgba = decodeDXT5(raw, tex.w, tex.h)
  else if (tex.format === 8) rgba = decodeRG88(raw, tex.w, tex.h)
  else if (tex.format === 9) rgba = decodeR8(raw, tex.w, tex.h)
  else throw new Error(`unsupported tex format ${TEX_FORMATS[tex.format] ?? tex.format}`)
  return { data: encodePng(rgba, tex.w, tex.h), contentType: 'image/png', anim: null, flat: null, videos: null }
}

// ── PKG container ──────────────────────────────────────────────────────────

/**
 * Parse a PKGV container header and entry table.
 * @param {Buffer} buf Whole scene.pkg contents.
 * @returns {{ magic: string, entries: { path: string, offset: number, size: number }[], dataBase: number }}
 */
function parsePkg(buf) {
  let off = 0
  off += 4
  const magic = buf.toString('ascii', off, off + 8)
  off += 8
  if (!/^PKGV00\d\d$/.test(magic)) throw new Error(`bad pkg magic ${magic}`)
  const count = buf.readUInt32LE(off)
  off += 4
  const entries = []
  for (let i = 0; i < count; i++) {
    const pathLen = buf.readUInt32LE(off)
    off += 4
    if (pathLen <= 0 || pathLen > 1024) throw new Error(`entry ${i}: bad pathLen ${pathLen}`)
    const p = buf.toString('utf8', off, off + pathLen)
    off += pathLen
    const offset = buf.readUInt32LE(off)
    off += 4
    const size = buf.readUInt32LE(off)
    off += 4
    entries.push({ path: p, offset, size })
  }
  return { magic, entries, dataBase: off }
}

// ── TEX container ──────────────────────────────────────────────────────────

/**
 * Parse a TEX texture header up to the first mipmap of the first image.
 * @param {Buffer} buf Whole .tex entry contents.
 * @returns {{ format: number, texW: number, texH: number, imageFormat: number,
 *   w: number, h: number, lz4: number, decomp: number, byteCount: number, dataOffset: number,
 *   frames: { u0: number, v0: number, u1: number, v1: number, aspect: number }[] | null }}
 */
function parseTex(buf) {
  if (buf.toString('ascii', 0, 4) !== 'TEXV') throw new Error('not a TEX file')
  let o = 9 // TEXV0005\0
  const texi = buf.toString('ascii', o, o + 8)
  o += 9
  if (texi !== 'TEXI0001') throw new Error(`bad info chunk ${texi}`)
  const format = buf.readInt32LE(o); o += 4
  const flags = buf.readInt32LE(o); o += 4
  const texW = buf.readInt32LE(o); o += 4
  const texH = buf.readInt32LE(o); o += 4
  const imgW = buf.readInt32LE(o); o += 4
  const imgH = buf.readInt32LE(o); o += 4
  o += 4 // average color
  const texb = buf.toString('ascii', o, o + 8); o += 9
  const imageCount = buf.readInt32LE(o); o += 4
  let imageFormat = -1
  if (texb === 'TEXB0003' || texb === 'TEXB0004') {
    imageFormat = buf.readInt32LE(o); o += 4
  }
  if (texb === 'TEXB0004') o += 4 // isVideoMp4
  const mipmapCount = buf.readInt32LE(o); o += 4
  // first mipmap of the first image
  const w = buf.readInt32LE(o); o += 4
  const h = buf.readInt32LE(o); o += 4
  const lz4 = buf.readInt32LE(o); o += 4
  const decomp = buf.readInt32LE(o); o += 4
  const byteCount = buf.readInt32LE(o); o += 4
  const frames = parseTexsFrames(buf, o, byteCount, mipmapCount, w, h)
  return { format, flags, texW, texH, imgW, imgH, imageFormat, imageCount, mipmapCount, w, h, lz4, decomp, byteCount, dataOffset: o, frames }
}

/**
 * Sprite-sheet (TEXS0002/0003) frame table following the mipmap chain:
 * 32-byte records `{ imageId i32, frametime f32, x f32, y f32, xAxis f32x2,
 * yAxis f32x2 }`. Frame pixel coordinates are absolute in the decoded
 * texture; the UV rect is normalized by texture size. Some sheets declare
 * frames past the texture edge — clamped like GPU addressing.
 * @returns {{ u0: number, v0: number, u1: number, v1: number, aspect: number }[] | null}
 */
function parseTexsFrames(buf, dataOffset, byteCount, mips, w, h) {
  let p = dataOffset + byteCount
  for (let m = 1; m < mips; m++) {
    if (p + 20 > buf.length) return null
    p += 20 + buf.readInt32LE(p + 16)
  }
  if (p + 9 > buf.length) return null
  const tag = buf.toString('ascii', p, p + 8)
  if (!/^TEXS\d{4}$/.test(tag)) return null
  const ver = parseInt(tag.slice(4, 8), 10)
  if (ver > 3) return null
  p += 9
  const count = buf.readUInt32LE(p); p += 4
  if (ver >= 3) p += 8 // cell width/height
  const frames = []
  for (let i = 0; i < count && p + 32 <= buf.length; i++) {
    const x = buf.readFloatLE(p + 8)
    const y = buf.readFloatLE(p + 12)
    const fw = Math.hypot(buf.readFloatLE(p + 16), buf.readFloatLE(p + 20))
    const fh = Math.hypot(buf.readFloatLE(p + 24), buf.readFloatLE(p + 28))
    p += 32
    if (fw <= 0 || fh <= 0) continue
    const u0 = Math.max(0, Math.min(1, x / w))
    const v0 = Math.max(0, Math.min(1, y / h))
    const u1 = Math.max(0, Math.min(1, (x + fw) / w))
    const v1 = Math.max(0, Math.min(1, (y + fh) / h))
    if (u1 - u0 < 1e-6 || v1 - v0 < 1e-6) continue
    frames.push({ u0, v0, u1, v1, aspect: fh / fw })
  }
  return frames.length ? frames : null
}

// ── LZ4 block decode ───────────────────────────────────────────────────────

/**
 * Decode one LZ4 block (the format Wallpaper Engine stores in TEX mipmaps).
 * @param {Buffer} src Compressed bytes.
 * @param {number} outSize Declared decompressed size.
 * @returns {Buffer} Decompressed bytes (zero-padded past a truncated stream).
 */
function lz4Decode(src, outSize) {
  const dst = Buffer.alloc(outSize)
  let s = 0
  let d = 0
  while (s < src.length) {
    const token = src[s++]
    let litLen = token >> 4
    if (litLen === 15) {
      let b
      do { b = src[s++]; litLen += b } while (b === 255)
    }
    src.copy(dst, d, s, s + litLen)
    s += litLen
    d += litLen
    if (s >= src.length) break
    const matchOffset = src.readUInt16LE(s)
    s += 2
    let matchLen = (token & 0xf) + 4
    if ((token & 0xf) === 15) {
      let b
      do { b = src[s++]; matchLen += b } while (b === 255)
    }
    let m = d - matchOffset
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++]
  }
  return dst.subarray(0, d)
}

// ── DXT / RGBA decode ──────────────────────────────────────────────────────

/** Expand a 5:6:5 RGB565 value to 8-bit components. */
function expand565(c) {
  const r = (c >> 11) & 0x1f
  const g = (c >> 5) & 0x3f
  const b = c & 0x1f
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

/**
 * Decode a whole block-compressed image by painting each 4×4 block.
 * @param {Buffer} data Raw (decompressed) block data.
 * @param {number} w Image width in pixels.
 * @param {number} h Image height in pixels.
 * @param {number} bytesPerBlock Bytes per compressed block.
 * @param {(src: Buffer, off: number, out: Buffer, w: number, h: number, x0: number, y0: number) => void} paintBlock
 *   Paints one block into the RGBA output.
 * @returns {Buffer} RGBA pixel data (w*h*4 bytes).
 */
function decodeBlocks(data, w, h, bytesPerBlock, paintBlock) {
  const out = Buffer.alloc(w * h * 4)
  const bw = Math.ceil(w / 4)
  const bh = Math.ceil(h / 4)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      paintBlock(data, (by * bw + bx) * bytesPerBlock, out, w, h, bx * 4, by * 4)
    }
  }
  return out
}

/** Write one RGBA pixel with clipping at the image edge. */
function putPixel(out, w, h, x, y, r, g, b, a) {
  if (x >= w || y >= h) return
  const i = (y * w + x) * 4
  out[i] = r
  out[i + 1] = g
  out[i + 2] = b
  out[i + 3] = a
}

/** Paint one DXT1 (or the color half of a DXT3/5) block. */
function paintColor(src, off, out, w, h, x0, y0, dxt1) {
  const c0 = src.readUInt16LE(off)
  const c1 = src.readUInt16LE(off + 2)
  const p0 = expand565(c0)
  const p1 = expand565(c1)
  const pal = [p0, p1]
  if (c0 > c1 || !dxt1) {
    pal.push([(p0[0] * 2 + p1[0]) / 3 | 0, (p0[1] * 2 + p1[1]) / 3 | 0, (p0[2] * 2 + p1[2]) / 3 | 0])
    pal.push([(p0[0] + p1[0] * 2) / 3 | 0, (p0[1] + p1[1] * 2) / 3 | 0, (p0[2] + p1[2] * 2) / 3 | 0])
  } else {
    pal.push([(p0[0] + p1[0]) / 2 | 0, (p0[1] + p1[1]) / 2 | 0, (p0[2] + p1[2]) / 2 | 0])
    pal.push([0, 0, 0])
  }
  const bits = src.readUInt32LE(off + 4)
  for (let i = 0; i < 16; i++) {
    const code = (bits >> (2 * i)) & 3
    const alpha = dxt1 && c0 <= c1 && code === 3 ? 0 : 255
    putPixel(out, w, h, x0 + (i & 3), y0 + (i >> 2), pal[code][0], pal[code][1], pal[code][2], alpha)
  }
}

/** Decode a DXT1 image. */
function decodeDXT1(data, w, h) {
  return decodeBlocks(data, w, h, 8, (src, off, out, w, h, x0, y0) => paintColor(src, off, out, w, h, x0, y0, true))
}

/** Decode a DXT3 image. */
function decodeDXT3(data, w, h) {
  return decodeBlocks(data, w, h, 16, (src, off, out, w, h, x0, y0) => {
    const bits = src.readUInt32LE(off)
    const bits2 = src.readUInt32LE(off + 4)
    const colorOff = off + 8
    const cbits = src.readUInt32LE(colorOff + 4)
    const c0 = src.readUInt16LE(colorOff)
    const c1 = src.readUInt16LE(colorOff + 2)
    const p0 = expand565(c0)
    const p1 = expand565(c1)
    const pal = [p0, p1,
      [(p0[0] * 2 + p1[0]) / 3 | 0, (p0[1] * 2 + p1[1]) / 3 | 0, (p0[2] * 2 + p1[2]) / 3 | 0],
      [(p0[0] + p1[0] * 2) / 3 | 0, (p0[1] + p1[1] * 2) / 3 | 0, (p0[2] + p1[2] * 2) / 3 | 0]]
    for (let i = 0; i < 16; i++) {
      const code = (cbits >> (2 * i)) & 3
      const a4 = i < 8 ? (bits >> (4 * i)) & 0xf : (bits2 >> (4 * (i - 8))) & 0xf
      putPixel(out, w, h, x0 + (i & 3), y0 + (i >> 2), pal[code][0], pal[code][1], pal[code][2], (a4 << 4) | a4)
    }
  })
}

/** Decode a DXT5 image. */
function decodeDXT5(data, w, h) {
  return decodeBlocks(data, w, h, 16, (src, off, out, w, h, x0, y0) => {
    const a0 = src[off]
    const a1 = src[off + 1]
    const apal = [a0, a1]
    if (a0 > a1) {
      for (let i = 2; i < 8; i++) apal.push(((8 - i) * a0 + (i - 1) * a1) / 7 | 0)
    } else {
      apal.push((4 * a0 + a1) / 5 | 0, (3 * a0 + 2 * a1) / 5 | 0, (2 * a0 + 3 * a1) / 5 | 0, (a0 + 4 * a1) / 5 | 0, 0, 255)
    }
    const alphaBits = src.readBigUInt64LE(off + 2) & 0xffffffffffffn
    const colorOff = off + 8
    const cbits = src.readUInt32LE(colorOff + 4)
    const c0 = src.readUInt16LE(colorOff)
    const c1 = src.readUInt16LE(colorOff + 2)
    const p0 = expand565(c0)
    const p1 = expand565(c1)
    const pal = [p0, p1,
      [(p0[0] * 2 + p1[0]) / 3 | 0, (p0[1] * 2 + p1[1]) / 3 | 0, (p0[2] * 2 + p1[2]) / 3 | 0],
      [(p0[0] + p1[0] * 2) / 3 | 0, (p0[1] + p1[1] * 2) / 3 | 0, (p0[2] + p1[2] * 2) / 3 | 0]]
    for (let i = 0; i < 16; i++) {
      const code = (cbits >> (2 * i)) & 3
      const ai = Number((alphaBits >> BigInt(3 * i)) & 7n)
      putPixel(out, w, h, x0 + (i & 3), y0 + (i >> 2), pal[code][0], pal[code][1], pal[code][2], apal[ai])
    }
  })
}

/** Decode an uncompressed RGBA8888 image. */
function decodeRGBA(data, w, h) {
  const out = Buffer.alloc(w * h * 4)
  data.copy(out, 0, 0, Math.min(data.length, out.length))
  return out
}

// Two-channel RG88 (tex-json "rg88", alphachannelpriority): R = luminance mask,
// G = tighter alpha coverage.
/** @returns {Buffer} RGBA pixel data. */
function decodeRG88(data, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 2]
    out[i * 4] = r; out[i * 4 + 1] = r; out[i * 4 + 2] = r; out[i * 4 + 3] = data[i * 2 + 1]
  }
  return out
}

// Single-channel R8 (tex-json "r8"); the value is both luminance and coverage.
/** @returns {Buffer} RGBA pixel data. */
function decodeR8(data, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = data[i]
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = v
  }
  return out
}

// ── PNG decode (8-bit, non-interlaced, color types 0/2/3/4/6) ──────────────

/** Reverse one PNG scanline filter in place. */
function unfilterLine(filter, line, prev, stride, bpp) {
  if (filter === 1) {
    for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff
  } else if (filter === 2) {
    for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff
  } else if (filter === 3) {
    for (let i = 0; i < stride; i++) {
      const left = i < bpp ? 0 : line[i - bpp]
      line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff
    }
  } else if (filter === 4) {
    for (let i = 0; i < stride; i++) {
      const a = i < bpp ? 0 : line[i - bpp]
      const b = prev[i]
      const c = i < bpp ? 0 : prev[i - bpp]
      const pp = a + b - c
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
      line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
    }
  }
}

/**
 * Decode a PNG payload to RGBA. Free-image .tex entries store the authored
 * file as-is (imageFormat 13), sometimes LZ4-wrapped.
 * @param {Buffer} buf PNG file bytes.
 * @returns {{ rgba: Buffer, w: number, h: number }} Decoded pixels.
 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let o = 8
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0
  const idat = []
  let plte = null
  let trns = null
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('ascii', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + len
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG depth=${depth} interlace=${interlace}`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported PNG colorType=${colorType}`)
  if (colorType === 3 && !plte) throw new Error('palette PNG without PLTE')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const rgba = Buffer.alloc(w * h * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    raw.copy(line, 0, p, p + stride)
    p += stride
    unfilterLine(filter, line, prev, stride, channels)
    for (let x = 0; x < w; x++) {
      const i = x * channels
      const j = (y * w + x) * 4
      if (colorType === 6) {
        rgba[j] = line[i]; rgba[j + 1] = line[i + 1]; rgba[j + 2] = line[i + 2]; rgba[j + 3] = line[i + 3]
      } else if (colorType === 2) {
        rgba[j] = line[i]; rgba[j + 1] = line[i + 1]; rgba[j + 2] = line[i + 2]; rgba[j + 3] = 255
      } else if (colorType === 4) {
        const g = line[i]
        rgba[j] = g; rgba[j + 1] = g; rgba[j + 2] = g; rgba[j + 3] = line[i + 1]
      } else if (colorType === 0) {
        const g = line[i]
        rgba[j] = g; rgba[j + 1] = g; rgba[j + 2] = g; rgba[j + 3] = 255
      } else {
        const e = line[i] * 3
        rgba[j] = plte[e]; rgba[j + 1] = plte[e + 1]; rgba[j + 2] = plte[e + 2]
        rgba[j + 3] = trns && line[i] < trns.length ? trns[line[i]] : 255
      }
    }
    line.copy(prev)
  }
  return { rgba, w, h }
}

/**
 * Decode a .tex entry to RGBA pixels; null when the payload has no decoder
 * here (JPEG free-image payloads).
 * @param {Buffer} texBuf Whole .tex entry contents.
 * @returns {{ rgba: Buffer, w: number, h: number, imgW: number, imgH: number } | null}
 */
function texToRgba(texBuf) {
  const tex = parseTex(texBuf)
  const mipData = texBuf.subarray(tex.dataOffset, tex.dataOffset + tex.byteCount)
  if (tex.imageFormat === 13) {
    const png = decodePng(tex.lz4 ? lz4Decode(mipData, tex.decomp) : mipData)
    return { ...png, imgW: tex.imgW || png.w, imgH: tex.imgH || png.h, frames: tex.frames }
  }
  // JPEG-in-TEX: scene wallpapers commonly store the main image layer as a
  // free-image JPEG. Decoding it here is what lets the composite paint the
  // layer — returning null drops it and the scene renders as bare
  // clearcolor behind its particles.
  if (tex.imageFormat === 2) {
    const jpg = decodeJpeg(tex.lz4 ? lz4Decode(mipData, tex.decomp) : mipData, { useTArray: true, formatAsRGBA: true })
    const imgW = tex.imgW > 0 && tex.imgW <= jpg.width ? tex.imgW : jpg.width
    const imgH = tex.imgH > 0 && tex.imgH <= jpg.height ? tex.imgH : jpg.height
    return { rgba: Buffer.from(jpg.data.buffer, jpg.data.byteOffset, jpg.data.byteLength), w: jpg.width, h: jpg.height, imgW, imgH, frames: tex.frames }
  }
  const raw = tex.lz4 ? lz4Decode(mipData, tex.decomp) : mipData
  let rgba = null
  if (tex.format === 0) rgba = decodeRGBA(raw, tex.w, tex.h)
  else if (tex.format === 7) rgba = decodeDXT1(raw, tex.w, tex.h)
  else if (tex.format === 6) rgba = decodeDXT3(raw, tex.w, tex.h)
  else if (tex.format === 4) rgba = decodeDXT5(raw, tex.w, tex.h)
  else if (tex.format === 8) rgba = decodeRG88(raw, tex.w, tex.h)
  else if (tex.format === 9) rgba = decodeR8(raw, tex.w, tex.h)
  if (!rgba) return null
  const imgW = tex.imgW > 0 && tex.imgW <= tex.w ? tex.imgW : tex.w
  const imgH = tex.imgH > 0 && tex.imgH <= tex.h ? tex.imgH : tex.h
  return { rgba, w: tex.w, h: tex.h, imgW, imgH, frames: tex.frames }
}

// ── PNG encode ─────────────────────────────────────────────────────────────

/** CRC-32 lookup table for the PNG encoder. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

/** CRC-32 of a buffer, as used by PNG chunks. */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Build one PNG chunk (length + type + data + CRC). */
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encode RGBA pixels as an 8-bit PNG. */
function encodePng(rgba, w, h) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── affine transforms (y-up scene space) ───────────────────────────────────

/** Identity 2D affine matrix `{a,b,c,d,e,f}` (column-major 2×3). */
const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/**
 * Multiply two affine matrices: `matMul(m, n)` transforms a point as `m(n(p))`.
 * @returns {{ a: number, b: number, c: number, d: number, e: number, f: number }}
 */
const matMul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
})

/** Invert an affine matrix. */
const matInv = (m) => {
  const det = m.a * m.d - m.b * m.c
  return {
    a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

/** Apply an affine matrix to a point. */
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]

/** 2D affine from the in-plane part of a column-major 4×4 MDL matrix. */
function affFrom16(m) {
  return { a: m[0], b: m[1], c: m[4], d: m[5], e: m[12], f: m[13] }
}

// ── lightshafts effect (DIRECTDRAW shape-quads) ─────────────────────────────

/** GLSL smoothstep on scalars; `e0 > e1` yields the mirrored ramp. */
const smoothstepf = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * WE's `squareToQuad` (assets/shaders/common_perspective.h), row-major: the
 * homography mapping the unit square onto the quad `p0..p3` with the corner
 * pairing the lightshafts vertex shader passes (p0→p1 one edge, p3→p2 the
 * opposite). Degenerate quads fall back to the affine branch.
 * @param {[number, number]} p0 Corner constant `point0`.
 * @param {[number, number]} p1 Corner constant `point1`.
 * @param {[number, number]} p2 Corner constant `point2`.
 * @param {[number, number]} p3 Corner constant `point3`.
 * @returns {number[][]} 3×3 rows.
 */
function squareToQuad(p0, p1, p2, p3) {
  const dx0 = p0[0], dy0 = p0[1]
  const dx1 = p1[0], dy1 = p1[1]
  const dx2 = p3[0], dy2 = p3[1]
  const dx3 = p2[0], dy3 = p2[1]
  const diffx1 = dx1 - dx3, diffy1 = dy1 - dy3
  const diffx2 = dx2 - dx3, diffy2 = dy2 - dy3
  const det = diffx1 * diffy2 - diffx2 * diffy1
  const sumx = dx0 - dx1 + dx3 - dx2
  const sumy = dy0 - dy1 + dy3 - dy2
  if (det === 0 || (sumx === 0 && sumy === 0)) {
    return [
      [dx1 - dx0, dy1 - dy0, 0],
      [dx3 - dx1, dy3 - dy1, 0],
      [dx0, dy0, 1],
    ]
  }
  const g = (sumx * diffy2 - diffx2 * sumy) / det
  const h = (diffx1 * sumy - sumx * diffy1) / det
  return [
    [dx1 - dx0 + g * dx1, dy1 - dy0 + g * dy1, g],
    [dx2 - dx0 + h * dx2, dy2 - dy0 + h * dy2, h],
    [dx0, dy0, 1],
  ]
}

/**
 * Inverse of a row-major 3×3 matrix; null when singular. Mirrors the shader
 * library's `inverse(mat3)`.
 * @param {number[][]} m 3×3 rows.
 * @returns {number[][] | null}
 */
function mat3Inv(m) {
  const a = [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
  const [r0, r1, r2] = a
  const b01 = r2[2] * r1[1] - r1[2] * r2[1]
  const b11 = -r2[2] * r1[0] + r1[2] * r2[0]
  const b21 = r2[1] * r1[0] - r1[1] * r2[0]
  const det = r0[0] * b01 + r0[1] * b11 + r0[2] * b21
  if (Math.abs(det) < 1e-12) return null
  const di = 1 / det
  const inv = [
    [b01 * di, (-r2[2] * r0[1] + r0[2] * r2[1]) * di, (r1[2] * r0[1] - r0[2] * r1[1]) * di],
    [b11 * di, (r2[2] * r0[0] - r0[2] * r2[0]) * di, (-r1[2] * r0[0] + r0[2] * r1[0]) * di],
    [b21 * di, (-r2[1] * r0[0] + r0[1] * r2[0]) * di, (r1[1] * r0[0] - r0[1] * r1[0]) * di],
  ]
  return [[inv[0][0], inv[1][0], inv[2][0]], [inv[0][1], inv[1][1], inv[2][1]], [inv[0][2], inv[1][2], inv[2][2]]]
}

/**
 * Bilinear red-channel sample of a repeat-wrapped texture, 0..1. The
 * lightshafts shader samples the shared noise texture with wrapping
 * addressing (ray coordinates run past the unit range and go negative).
 * @param {{ rgba: Buffer, w: number, h: number }} tex Decoded texture.
 * @param {number} u Horizontal coordinate (any range).
 * @param {number} v Vertical coordinate (any range).
 * @returns {number}
 */
function sampleRedWrap(tex, u, v) {
  const { rgba, w, h } = tex
  const uu = u - Math.floor(u), vv = v - Math.floor(v)
  const fx = uu * w - 0.5, fy = vv * h - 0.5
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const gx = fx - x0, gy = fy - y0
  const xa = ((x0 % w) + w) % w, xb = ((x0 + 1) % w + w) % w
  const ya = ((y0 % h) + h) % h, yb = ((y0 + 1) % h + h) % h
  const i00 = (ya * w + xa) * 4, i10 = (ya * w + xb) * 4
  const i01 = (yb * w + xa) * 4, i11 = (yb * w + xb) * 4
  return (rgba[i00] * (1 - gx) * (1 - gy) + rgba[i10] * gx * (1 - gy)
    + rgba[i01] * (1 - gx) * gy + rgba[i11] * gx * gy) / 255
}

/**
 * Bilinear RGB sample of a clamp-addressed texture; the lightshafts shader
 * reads the gradient map this way.
 * @param {{ rgba: Buffer, w: number, h: number }} tex Decoded texture.
 * @param {number} u Horizontal coordinate (clamped to 0..1).
 * @param {number} v Vertical coordinate (clamped to 0..1).
 * @param {number[]} out Reused `[r, g, b]` slot in 0..255.
 * @returns {void}
 */
function sampleRgbClamp(tex, u, v, out) {
  const { rgba, w, h } = tex
  const uu = Math.max(0, Math.min(1, u)), vv = Math.max(0, Math.min(1, v))
  const fx = Math.min(w - 1, Math.max(0, uu * w - 0.5)), fy = Math.min(h - 1, Math.max(0, vv * h - 0.5))
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
  const gx = fx - x0, gy = fy - y0
  for (let c = 0; c < 3; c++) {
    const i00 = (y0 * w + x0) * 4 + c, i10 = (y0 * w + x1) * 4 + c
    const i01 = (y1 * w + x0) * 4 + c, i11 = (y1 * w + x1) * 4 + c
    out[c] = rgba[i00] * (1 - gx) * (1 - gy) + rgba[i10] * gx * (1 - gy)
      + rgba[i01] * (1 - gx) * gy + rgba[i11] * gx * gy
  }
}

// ── MDL parser (puppet format) ─────────────────────────────────────────────

/**
 * Parse a puppet .mdl entry: skinned mesh, bind-pose skeleton and named MDAT
 * attachment table. Layout per ref/WPMdlParser.cpp; throws on non-puppet
 * meshes (flag 9/11/15/39) which callers render as plain image quads.
 * @param {Buffer} f Whole .mdl entry contents.
 * @returns {{ verts: {x: number, y: number, u: number, v: number}[],
 *   indices: number[], bones: { parent: number, local: object }[],
 *   boneWorld: object[], atts: Map<string, { bone: number, local: object }> }}
 */
function parseMdl(f) {
  let p = 0
  const u32 = () => { const v = f.readUInt32LE(p); p += 4; return v }
  const u16 = () => { const v = f.readUInt16LE(p); p += 2; return v }
  const u8 = () => { const v = f[p]; p += 1; return v }
  const f32 = () => { const v = f.readFloatLE(p); p += 4; return v }
  const str = () => { const end = f.indexOf(0, p); const s = f.toString('utf8', p, end); p = end + 1; return s }
  const mat16 = () => { const m = []; for (let i = 0; i < 16; i++) m.push(f32()); return m }

  if (f.toString('ascii', 0, 4) !== 'MDLV') throw new Error('not an MDL file')
  const mdlv = parseInt(f.toString('ascii', 4, 8), 10)
  p = 9
  const flag = u32()
  if ([9, 11, 15, 39].includes(flag)) throw new Error('non-puppet MDL')
  u32(); u32(); str(); u32()
  if (mdlv >= 17) p += 24

  let curr = u32()
  let alt = false
  if (curr === 0) {
    alt = true
    while (curr !== 0x0180000F) {
      if (p >= f.length) throw new Error('EOF scanning alt-format herald')
      curr = u32()
    }
    curr = u32()
  } else if (curr === 0x01800009 || curr === 0x0180000F) {
    alt = curr === 0x0180000F
    curr = u32()
  }
  const vertSize = curr
  const stride = alt ? 80 : 52
  if (vertSize % stride !== 0) throw new Error(`unsupported mdl vertex size ${vertSize}`)
  const vn = vertSize / stride
  const verts = []
  for (let i = 0; i < vn; i++) {
    const x = f32(), y = f32()
    f32() // z
    if (alt) p += 28
    p += 16 // blend indices
    p += 16 // blend weights
    const u = f32(), v = f32()
    verts.push({ x, y, u, v })
  }
  const idxSize = u32()
  if (idxSize % 6 !== 0) throw new Error(`unsupported mdl indices size ${idxSize}`)
  const indices = []
  for (let i = 0; i < idxSize / 6; i++) {
    indices.push(u16(), u16(), u16())
  }

  const idx = f.indexOf(Buffer.from('MDLS'), p)
  if (idx < 0) throw new Error('no MDLS section')
  p = idx + 9
  u32() // bones_file_end
  const bn = u16()
  u16()
  const bones = []
  for (let i = 0; i < bn; i++) {
    str() // name
    u32() // unk
    const parent = u32()
    u32() // size (64)
    const m = mat16()
    str() // bone_simulation_json
    bones.push({ parent, local: affFrom16(m) })
  }
  // Accumulated bind-pose world transform per bone.
  const boneWorld = []
  for (let i = 0; i < bn; i++) {
    const b = bones[i]
    boneWorld[i] = b.parent === 0xffffffff || b.parent >= i ? bones[i].local : matMul(boneWorld[b.parent], b.local)
  }

  const mdls = parseInt(f.toString('ascii', idx + 4, idx + 8), 10)
  if (mdls > 1) {
    p += 2
    if (u8()) p += bn * 64
    const su = u32(); p += su * 12
    u32()
    if (u8()) p += bn * 76
    if (u8()) p += bn * 4
    if (mdls >= 4) { if (u8()) p += bn * 4 }
  }
  const atts = new Map()
  for (let g = 0; g < 8 && p < f.length; g++) {
    const i1 = f.indexOf(Buffer.from('MDAT'), p)
    const i2 = f.indexOf(Buffer.from('MDLA'), p)
    if (i2 >= 0 && (i1 < 0 || i2 < i1)) break
    if (i1 < 0) break
    p = i1 + 9
    u32()
    const n = u16()
    for (let i = 0; i < n; i++) {
      const bi = u16()
      const name = str()
      const m = mat16()
      atts.set(name, { bone: bi, local: affFrom16(m) })
    }
  }
  return { verts, indices, bones, boneWorld, atts }
}

// ── scene composite ────────────────────────────────────────────────────────

/** Normalize a scene reference path (forward slashes, no leading ./). */
function normalizeRef(ref) {
  return String(ref).replace(/\\/g, '/').replace(/^\.\//, '')
}

// ── colorBlendMode (scene object blend modes) ──────────────────────────────
// Wallpaper Engine image objects carry a Photoshop-style blend mode the editor
// writes as `colorBlendMode`. The authoritative semantics are Wallpaper
// Engine's own `common_blending.h` ApplyBlending: `mix(A, F(A, B), opacity)`
// where A is the backdrop color, B the layer color and opacity the layer's
// final alpha; a few modes deviate (5 and 10 ignore opacity, 31 and 32 apply
// it inside F). Without this port, glow layers authored as black-bodied
// textures with Screen blending (e.g. workshop 3600720818's rainbow lens
// flare) paint their black body as an opaque diamond over the art.

/**
 * Per-channel blend functions, 0..1 domain. Keys are `colorBlendMode` values.
 * @type {Record<number, (a: number, b: number) => number>}
 */
const CHANNEL_BLEND = {
  1: (a, b) => Math.min(a, b), // Darken
  2: (a, b) => a * b, // Multiply
  3: (a, b) => (b === 0 ? b : Math.max(1 - (1 - a) / b, 0)), // ColorBurn
  4: (a, b) => Math.max(a + b - 1, 0), // LinearBurn / Substract
  5: (a, b) => Math.min(a, b), // DarkerColor: per-channel min, opacity ignored by the shader
  6: (a, b) => Math.max(a, b), // Lighten
  7: (a, b) => 1 - (1 - a) * (1 - b), // Screen
  8: (a, b) => (b === 1 ? b : Math.min(a / (1 - b), 1)), // ColorDodge
  9: (a, b) => Math.min(a + b, 1), // Add
  10: (a, b) => Math.max(a, b), // LighterColor: per-channel max, opacity ignored by the shader
  11: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)), // Overlay
  12: (a, b) => (b < 0.5 ? 2 * a * b + a * a * (1 - 2 * b) : Math.sqrt(a) * (2 * b - 1) + 2 * a * (1 - b)), // SoftLight
  13: (a, b) => (b < 0.5 ? 2 * b * a : 1 - 2 * (1 - b) * (1 - a)), // HardLight (Overlay swapped)
  14: (a, b) => (b < 0.5 ? CHANNEL_BLEND[3](a, 2 * b) : CHANNEL_BLEND[8](a, 2 * (b - 0.5))), // VividLight
  15: (a, b) => (b < 0.5 ? CHANNEL_BLEND[4](a, 2 * b) : a + 2 * (b - 0.5)), // LinearLight (LinearDodge is unclamped before the opacity mix)
  16: (a, b) => (b < 0.5 ? Math.min(a, 2 * b) : Math.max(a, 2 * (b - 0.5))), // PinLight
  17: (a, b) => (CHANNEL_BLEND[14](a, b) < 0.5 ? 0 : 1), // HardMix
  18: (a, b) => Math.abs(a - b), // Difference
  19: (a, b) => a + b - 2 * a * b, // Exclusion
  20: (a, b) => Math.max(a + b - 1, 0), // Substract
  21: (a, b) => (b === 1 ? b : Math.min((a * a) / (1 - b), 1)), // Reflect
  22: (a, b) => CHANNEL_BLEND[21](b, a), // Glow (Reflect swapped)
  23: (a, b) => Math.min(a, b) - Math.max(a, b) + 1, // Phoenix
  24: (a, b) => (a + b) / 2, // Average
  25: (a, b) => 1 - Math.abs(1 - a - b), // Negation
}

/**
 * Blend one pixel per Wallpaper Engine's ApplyBlending. `out` receives the
 * blended 0..255 RGB triple; the backdrop alpha is kept (the engine's shader
 * assigns the backdrop's alpha to the blended fragment).
 * @param {number} mode `colorBlendMode` value (0 = plain alpha blend).
 * @param {number} ar Backdrop red 0..255.
 * @param {number} ag Backdrop green 0..255.
 * @param {number} ab Backdrop blue 0..255.
 * @param {number} br Layer red 0..255.
 * @param {number} bg Layer green 0..255.
 * @param {number} bb Layer blue 0..255.
 * @param {number} o Layer alpha 0..1.
 * @param {number[]} out Reused [r, g, b] output slot.
 * @returns {void}
 */
function applyColorBlend(mode, ar, ag, ab, br, bg, bb, o, out) {
  const a0 = ar / 255, a1 = ag / 255, a2 = ab / 255
  const b0 = br / 255, b1 = bg / 255, b2 = bb / 255
  let r, g, b
  if (mode === 31) { // Linear add with opacity inside F
    r = a0 + b0 * o
    g = a1 + b1 * o
    b = a2 + b2 * o
  } else if (mode === 32) { // A + A*B, then opacity mix
    r = a0 + (a0 * b0 - a0) * o
    g = a1 + (a1 * b1 - a1) * o
    b = a2 + (a2 * b2 - a2) * o
  } else if (mode === 30) { // Tint: backdrop max channel times layer color
    const m = Math.max(a0, a1, a2)
    r = a0 + (m * b0 - a0) * o
    g = a1 + (m * b1 - a1) * o
    b = a2 + (m * b2 - a2) * o
  } else if (mode === 26 || mode === 27 || mode === 28 || mode === 29) {
    const hslA = rgbToHsl(a0, a1, a2)
    const hslB = rgbToHsl(b0, b1, b2)
    let h, s, l
    if (mode === 26) { h = hslB[0]; s = hslA[1]; l = hslA[2] } // Hue
    else if (mode === 27) { h = hslA[0]; s = hslB[1]; l = hslA[2] } // Saturation
    else if (mode === 28) { h = hslB[0]; s = hslB[1]; l = hslA[2] } // Color
    else { h = hslA[0]; s = hslA[1]; l = hslB[2] } // Luminosity
    const [nr, ng, nb] = hslToRgb(h, s, l)
    r = a0 + (nr - a0) * o
    g = a1 + (ng - a1) * o
    b = a2 + (nb - a2) * o
  } else {
    const f = CHANNEL_BLEND[mode]
    if (mode === 5 || mode === 10) { // Darker/LighterColor: bare min/max, the shader skips the opacity mix
      r = f(a0, b0)
      g = f(a1, b1)
      b = f(a2, b2)
    } else if (f) {
      r = a0 + (f(a0, b0) - a0) * o
      g = a1 + (f(a1, b1) - a1) * o
      b = a2 + (f(a2, b2) - a2) * o
    } else {
      r = a0 + (b0 - a0) * o
      g = a1 + (b1 - a1) * o
      b = a2 + (b2 - a2) * o
    }
  }
  out[0] = r <= 0 ? 0 : r >= 1 ? 255 : r * 255
  out[1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255
  out[2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255
}

/**
 * Convert 0..1 RGB to HSL (Wallpaper Engine's shader RGBToHSL).
 * @returns {[number, number, number]}
 */
function rgbToHsl(r, g, b) {
  const fmin = Math.min(r, g, b)
  const fmax = Math.max(r, g, b)
  const delta = fmax - fmin
  const l = (fmax + fmin) / 2
  if (delta === 0) return [0, 0, l]
  const s = l < 0.5 ? delta / (fmax + fmin) : delta / (2 - fmax - fmin)
  const dr = (fmax - r) / 6 / delta + 0.5 / delta
  const dg = (fmax - g) / 6 / delta + 0.5 / delta
  const db = (fmax - b) / 6 / delta + 0.5 / delta
  let h
  if (r === fmax) h = db - dg
  else if (g === fmax) h = 1 / 3 + dr - db
  else h = 2 / 3 + dg - dr
  if (h < 0) h += 1
  else if (h > 1) h -= 1
  return [h, s, l]
}

/**
 * Convert HSL to 0..1 RGB (Wallpaper Engine's shader HSLToRGB).
 * @returns {[number, number, number]}
 */
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l]
  const f2 = l < 0.5 ? l * (1 + s) : l + s - l * s
  const f1 = 2 * l - f2
  const channel = (hue) => {
    if (hue < 0) hue += 1
    else if (hue > 1) hue -= 1
    if (6 * hue < 1) return f1 + (f2 - f1) * 6 * hue
    if (2 * hue < 1) return f2
    if (3 * hue < 2) return f1 + (f2 - f1) * (2 / 3 - hue) * 6
    return f1
  }
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
}

// ── particle systems: static steady-state approximation ────────────────────
// Wallpaper Engine simulates particle systems live. A static background
// approximates the steady state: for a continuously emitting system the live
// particles' normalized ages are uniform in [0,1], so every particle is
// sampled with a random phase instead of stepping a clock. Operators are
// absolute functions of normalized age (the renderer resets alpha/size/color
// to their init values each frame), so state at the sampled age is computed
// directly; only position integrates over time (analytic ballistic + drag).

/** Deterministic 32-bit RNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Parse a `"x y z"` scene vector (or a scalar broadcast to all components).
 * @param {string | number | { value: unknown }} v Raw scene value.
 * @param {[number, number, number]} [def] Default when unparseable.
 * @returns {[number, number, number]}
 */
function parseVec3(v, def = [0, 0, 0]) {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v]
  const m = /^(-?[\d.eE+]+) (-?[\d.eE+]+) (-?[\d.eE+]+)/.exec(String(propValue(v) ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : def
}

/**
 * Apply a scene object's `instanceoverride` (the editor's per-instance
 * particle overrides) to a compiled spec. Every field is a multiplier on the
 * preset: size/alpha/lifetime/speed/colorn scale the initializer ranges,
 * count scales the particle pool (maxcount plus emitter rate), rate scales
 * emission alone. `{ user, value }` bindings resolve to their value. Children
 * share references — each child object carries its own override. Without the
 * override the preset's authored sizes paint oversized (the Violet
 * "Asteroids" system ships 150–900 px rocks that WE shrinks to 21–126 px via
 * size 0.14).
 * @param {object} spec Compiled spec (loadParticleSpec product).
 * @param {object} [ov] Raw instanceoverride from scene.json, when present.
 * @returns {object} Overridden spec, or the input unchanged when no field applies.
 */
function applyInstanceOverride(spec, ov) {
  if (!spec || !ov || typeof ov !== 'object') return spec
  const mul = (range, k) => [range[0] * k, range[1] * k]
  const num = (v) => (typeof propValue(v) === 'number' && Number.isFinite(propValue(v)) ? propValue(v) : null)
  const size = num(ov.size)
  const alpha = num(ov.alpha)
  const lifetime = num(ov.lifetime)
  const speed = num(ov.speed)
  const count = num(ov.count)
  const rate = num(ov.rate)
  const colorn = parseVec3(ov.colorn, null)
  if (size == null && alpha == null && lifetime == null && speed == null && count == null && rate == null && !colorn) return spec
  const init = { ...spec.init }
  if (size != null) init.size = mul(spec.init.size, size)
  if (alpha != null) init.alpha = mul(spec.init.alpha, alpha)
  if (lifetime != null) init.lifetime = mul(spec.init.lifetime, lifetime)
  if (speed != null && spec.init.vel) init.vel = spec.init.vel.map((v) => [v[0] * speed, v[1] * speed, v[2] * speed])
  if (colorn && spec.init.color) init.color = spec.init.color.map((c) => [c[0] * colorn[0], c[1] * colorn[1], c[2] * colorn[2]])
  let emitters = spec.emitters
  let maxcount = spec.maxcount
  let total = spec.rate
  if (count != null || rate != null) {
    const k = (count ?? 1) * (rate ?? 1)
    emitters = spec.emitters.map((e) => ({ ...e, rate: e.rate * k }))
    total = spec.rate * k
    if (count != null) maxcount = Math.max(0, Math.round(spec.maxcount * count))
  }
  return { ...spec, init, emitters, rate: total, maxcount, children: spec.children }
}

const randRange = (rng, a, b) => a + rng() * (b - a)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** ValueChange lerp on normalized age (reference FadeValueChange). */
function fadeValueChange(t, vc) {
  if (t <= vc.starttime) return vc.startvalue
  if (t > vc.endtime) return vc.endvalue
  const pass = (t - vc.starttime) / (vc.endtime - vc.starttime)
  return vc.startvalue + (vc.endvalue - vc.startvalue) * pass
}

/** Normalized `{ starttime, endtime, startvalue, endvalue }` operator params. */
function readValueChange(j) {
  return {
    starttime: Number(j.starttime ?? 0),
    endtime: Number(j.endtime ?? 1),
    startvalue: Number(j.startvalue ?? 1),
    endvalue: Number(j.endvalue ?? 0),
  }
}

/** alphafade tent profile on normalized age. */
function alphaFade(t, fadein, fadeout) {
  if (t < fadein) return fadein > 1e-6 ? t / fadein : 1
  if (t > fadeout) return fadeout < 1 - 1e-6 ? (1 - t) / (1 - fadeout) : 1
  return 1
}

/**
 * FrequencyValue (oscillate* operators): per-particle random scale between
 * scalemin/scalemax and random angular speed between freqmin/freqmax.
 * oscillatesize defaults to 0.8–1.2 and oscillateposition to a 5 rad/s max
 * like the reference. The static sampler only uses the scales; the browser
 * simulator animates the oscillation phase with the frequency.
 */
function readFrequency(j) {
  let scalemin = Number(j.scalemin ?? 0)
  let scalemax = Number(j.scalemax ?? 1)
  if (j.name === 'oscillatesize' && j.scalemin == null && j.scalemax == null) { scalemin = 0.8; scalemax = 1.2 }
  const freqmin = Number(j.frequencymin ?? 0)
  let freqmax = Number(j.frequencymax ?? (j.name === 'oscillateposition' ? 5 : 0))
  if (freqmax === 0) freqmax = freqmin
  return { mask: parseVec3(j.mask, [1, 1, 0]), scalemin, scalemax, freqmin, freqmax }
}

/** Mean particle lifetime (capped: some authored systems live forever). */
function expectedLifetime(spec) {
  const [a, b] = spec.init.lifetime
  return Math.min((a + b) / 2, 120)
}

/** Live-particle count at steady state. */
function steadyCount(spec, capAge = Infinity) {
  if (spec.rate > 0) {
    const n = Math.round(spec.rate * Math.min(expectedLifetime(spec), capAge))
    return Math.max(0, Math.min(spec.maxcount, n))
  }
  if (spec.instantaneous > 0) return Math.min(spec.maxcount || spec.instantaneous, spec.instantaneous)
  return 0
}

/** Sample the initializer block (lifetime/size/alpha/color/velocity/rotation). */
function sampleInitState(spec, rng) {
  const { init } = spec
  const pick = (range) => randRange(rng, range[0], range[1])
  let lifetime = pick(init.lifetime)
  const [lmin, lmax] = init.lifetime
  if (lmin === lmax && lifetime > 0) lifetime *= 1 + randRange(rng, -0.05, 0.05) // reference jitter
  const size = pick(init.size)
  const alpha = pick(init.alpha)
  let color = [1, 1, 1]
  if (init.color) {
    color = [randRange(rng, init.color[0][0], init.color[1][0]), randRange(rng, init.color[0][1], init.color[1][1]), randRange(rng, init.color[0][2], init.color[1][2])]
  }
  let vel = [0, 0]
  if (init.vel) {
    vel = [randRange(rng, init.vel[0][0], init.vel[1][0]), randRange(rng, init.vel[0][1], init.vel[1][1])]
  }
  let rot = 0
  if (init.rot) rot = randRange(rng, init.rot[0][2], init.rot[1][2])
  let av = 0
  if (init.av) av = randRange(rng, init.av[0][2], init.av[1][2])
  if (init.turb) {
    const s = randRange(rng, init.turb.speed[0], init.turb.speed[1])
    vel[0] += randRange(rng, -1, 1) * s * init.turb.mask[0]
    vel[1] += randRange(rng, -1, 1) * s * init.turb.mask[1]
  }
  return { lifetime, age01: rng(), size, alpha, color, vel, rot, av, frameRoll: rng() }
}

/** Emitter spawn offset in system-local space (2D projection). */
function sampleEmitterPos(spec, rng) {
  const em = spec.emitters[0]
  if (!em) return [0, 0]
  let x = 0, y = 0
  if (em.box) {
    x = randRange(rng, em.distmin[0], em.distmax[0])
    y = randRange(rng, em.distmin[1], em.distmax[1])
  } else {
    const rmin = Math.min(em.distmin[0], em.distmin[1])
    const rmax = Math.max(em.distmax[0], em.distmax[1])
    const r = rmin + Math.cbrt(rng()) * (rmax - rmin)
    const th = rng() * Math.PI * 2
    x = r * Math.cos(th) * em.directions[0]
    y = r * Math.sin(th) * em.directions[1]
    if (em.sign[0]) x = Math.abs(x) * em.sign[0]
    if (em.sign[1]) y = Math.abs(y) * em.sign[1]
  }
  return [x + em.origin[0], y + em.origin[1]]
}

/** Random-phase oscillation offsets/alpha/size factors for one particle. */
function sampleOscillation(spec, rng) {
  const mk = (f) => (f ? randRange(rng, f.scalemin, f.scalemax) : null)
  const offX = spec.ops.oscPos ? (spec.ops.oscPos.mask[0] > 0.01 ? mk(spec.ops.oscPos) * Math.cos(rng() * Math.PI * 2) : 0) : 0
  const offY = spec.ops.oscPos ? (spec.ops.oscPos.mask[1] > 0.01 ? mk(spec.ops.oscPos) * Math.cos(rng() * Math.PI * 2) : 0) : 0
  // oscillatealpha/size multiplier: lerp((cos(phase)+1)/2, scalemin, scalemax) at a random phase
  const oscMul = (f) => (f ? f.scalemin + (f.scalemax - f.scalemin) * (Math.cos(rng() * Math.PI * 2) + 1) / 2 : 1)
  return { offX, offY, alphaMul: oscMul(spec.ops.oscAlpha), sizeMul: oscMul(spec.ops.oscSize) }
}

/**
 * Analytic trajectory closure: position at age `t` seconds (oscillation
 * excluded). Ballistic + drag first, then a rigid vortex rotation about the
 * vortex origin by the local angular speed times age, then the turbulence
 * drift. The turbulence operator drives every particle through a shared
 * noise field; the static approximation samples one constant drift vector
 * per particle (amplitude from its speed range, direction hashed on the
 * birth position so neighbouring particles drift coherently) saturating
 * over one field correlation time 2π/timescale — without it, line emitters
 * (e.g. Particle_flow) collapse every particle onto the emission line.
 * @param {() => number} rng Deterministic sampler for the per-particle
 *   turbulence amplitude.
 * @returns {(t: number) => [number, number]}
 */
function buildTraj(spec, spawn, vel, rng) {
  const mv = spec.ops.movement
  const vx = vel[0]
  const vy = vel[1]
  const vortex = spec.ops.vortex
  const turb = spec.ops.turb
  let turbDx = 0, turbDy = 0, turbTau = 1
  if (turb) {
    turbTau = (2 * Math.PI) / turb.timescale
    const amp = randRange(rng, turb.speedmin, turb.speedmax) * turbTau
    const h = Math.sin(spawn[0] * turb.scale * 12.9898 + spawn[1] * turb.scale * 78.233) * 43758.5453
    const ang = (h - Math.floor(h)) * 2 * Math.PI
    turbDx = Math.cos(ang) * amp * turb.mask[0]
    turbDy = Math.sin(ang) * amp * turb.mask[1]
  }
  const omegaAt = (x, y) => {
    if (!vortex) return 0
    const dx = x - vortex.origin[0]
    const dy = y - vortex.origin[1]
    const r = Math.hypot(dx, dy)
    const span = vortex.distOuter - vortex.distInner
    const k = span > 1e-6 ? clamp01((r - vortex.distInner) / span) : (r > vortex.distInner ? 1 : 0)
    const speed = vortex.speedInner + (vortex.speedOuter - vortex.speedInner) * k
    return r > 1e-6 ? speed / r : 0
  }
  return (t) => {
    let x = spawn[0], y = spawn[1]
    if (mv && (mv.gravity[0] || mv.gravity[1] || mv.drag > 0)) {
      const g = mv.gravity
      if (mv.drag > 1e-6) {
        // v(t)=g/drag+(v0-g/drag)e^(-drag t); x(t)=x0+v0*k+(g/drag)(t-k)
        const k = (1 - Math.exp(-mv.drag * t)) / mv.drag
        x += vx * k + (g[0] / mv.drag) * (t - k)
        y += vy * k + (g[1] / mv.drag) * (t - k)
      } else {
        x += vx * t + 0.5 * g[0] * t * t
        y += vy * t + 0.5 * g[1] * t * t
      }
    } else {
      x += vx * t
      y += vy * t
    }
    if (vortex) {
      const w = omegaAt(x, y) * t
      if (w !== 0) {
        const dx = x - vortex.origin[0]
        const dy = y - vortex.origin[1]
        const c = Math.cos(w), s = Math.sin(w)
        x = vortex.origin[0] + dx * c - dy * s
        y = vortex.origin[1] + dx * s + dy * c
      }
    }
    if (turb) {
      const sat = 1 - Math.exp(-t / turbTau)
      x += turbDx * sat
      y += turbDy * sat
    }
    return [x, y]
  }
}

/**
 * Sample one particle at a random steady-state phase.
 * `spawn` overrides the emitter position (event children spawn on the parent
 * particle's trajectory); `forceAge01` pins the phase (event children whose
 * window is clipped by the parent's age).
 */
function sampleParticle(spec, rng, spawn = null, forceAge01 = null) {
  const st = sampleInitState(spec, rng)
  const em = spec.emitters[0]
  let vel = st.vel
  if (!spec.init.vel && em) {
    // emitter speed along the (masked, normalized) spawn direction
    vel = [0, 0]
    if (em.speedmin !== 0 || em.speedmax !== 0) {
      const [ex, ey] = sampleEmitterPos(spec, rng)
      const len = Math.hypot(ex, ey)
      if (len > 1e-6) {
        const speed = randRange(rng, em.speedmin, em.speedmax)
        vel = [(speed * ex) / len, (speed * ey) / len]
      }
    }
  }
  const pos = spawn ?? sampleEmitterPos(spec, rng)
  const age01 = forceAge01 ?? st.age01
  const osc = sampleOscillation(spec, rng)
  return {
    L: st.lifetime, age01, age: age01 * st.lifetime,
    size0: st.size, alpha0: st.alpha, color0: st.color, rot0: st.rot, av: st.av,
    traj: buildTraj(spec, pos, vel, rng),
    osc,
  }
}

/** Sprite-sheet frame index at the particle's phase. */
function frameIndexOf(spec, p, frames) {
  const n = frames.length
  // randomframe: one random frame fixed at spawn (reference SpriteAnimation).
  if (spec.animationmode === 'randomframe') {
    return Math.max(0, Math.min(n - 1, Math.floor((p.frameRoll ?? 0) * n)))
  }
  return Math.max(0, Math.min(n - 1, Math.floor(p.age01 * spec.seqx * n)))
}

/** Absolute alpha/size/color/rotation at the sampled phase. */
function particleStateAt(spec, p) {
  let alpha = p.alpha0
  for (const f of spec.ops.alphaFns) alpha *= f(p.age01)
  alpha *= p.osc.alphaMul
  let size = p.size0
  for (const f of spec.ops.sizeFns) size *= f(p.age01)
  size *= p.osc.sizeMul
  let color = p.color0
  if (spec.ops.colorFn) {
    const c = spec.ops.colorFn(p.age01)
    color = [color[0] * c[0], color[1] * c[1], color[2] * c[2]]
  }
  let rot = p.rot0 + p.av * p.age
  const ang = spec.ops.angular
  if (ang) {
    const t = p.age
    if (ang.drag > 1e-6) {
      const k = (1 - Math.exp(-ang.drag * t)) / ang.drag
      rot += p.av * k + (ang.force / ang.drag) * (t - k)
    } else {
      rot += p.av * t + 0.5 * ang.force * t * t
    }
  }
  return { alpha, size, color, rot }
}

// ── particle animation export (browser-side simulator input) ────────────────
// The static composite stamps one steady-state frame. Live drift needs the
// particle definitions on the browser side: each system ships its local→
// projection matrix, plain-data initializer/emitter/operator parameters, and
// the composed alpha/size/color operator curves as [0,1] lookup tables
// (compiled operator closures cannot cross the wire). Texture atlases ride
// as PNGs (see the texture endpoints in index.js). The browser replays the
// same formulas this module samples statically — position/rotation stay
// analytic functions of age, so a respawned particle's state is exact and
// the simulation needs no integration error handling.

/** Samples per exported operator curve (normalized age 0..1 inclusive). */
const ANIM_LUT_N = 33

/**
 * Serialize one compiled particle spec into plain data for the browser
 * simulator. Children recurse; event children keep their type so the client
 * can skip them (event semantics are not simulated).
 * @param {object} spec Compiled spec (loadParticleSpec product).
 * @param {Map<string, number>} texMap Material ref → texture index (-1 when
 *   the material resolves to no texture).
 * @param {{ png: Buffer, frames: object[] | null, blending: string }[]} textures
 *   Accumulator the new textures append to.
 * @param {(ref: string) => ({ rgba: Buffer, w: number, h: number, frames: object[] | null, blending: string } | null)} texOf
 *   Texture resolver (the composite's particleTextureOf).
 * @returns {object | null} Plain-data spec, or null when absent.
 */
function exportAnimSpec(spec, texMap, textures, texOf) {
  if (!spec) return null
  const lut = (fns) => {
    const out = new Array(ANIM_LUT_N)
    for (let i = 0; i < ANIM_LUT_N; i++) {
      const t = i / (ANIM_LUT_N - 1)
      let v = 1
      for (const f of fns) v *= f(t)
      out[i] = v
    }
    return out
  }
  const ops = spec.ops
  const colorLUT = ops.colorFn
    ? Array.from({ length: ANIM_LUT_N }, (_, i) => ops.colorFn(i / (ANIM_LUT_N - 1)))
    : null
  let tex = null
  if (spec.material) {
    if (!texMap.has(spec.material)) {
      const info = texOf(spec.material)
      texMap.set(spec.material, info ? textures.length : -1)
      if (info) textures.push({ png: encodePng(info.rgba, info.w, info.h), frames: info.frames, blending: info.blending })
    }
    const idx = texMap.get(spec.material)
    tex = idx >= 0 ? idx : null
  }
  return {
    count: steadyCount(spec),
    starttime: spec.starttime,
    init: spec.init,
    emitters: spec.emitters,
    ops: {
      movement: ops.movement, angular: ops.angular,
      oscPos: ops.oscPos, oscAlpha: ops.oscAlpha, oscSize: ops.oscSize, vortex: ops.vortex,
      alphaLUT: lut(ops.alphaFns), sizeLUT: lut(ops.sizeFns), colorLUT,
    },
    animationmode: spec.animationmode,
    seqx: spec.seqx,
    tex,
    children: spec.children.map((c) => ({
      origin: [c.origin[0], c.origin[1]],
      type: c.type,
      spec: exportAnimSpec(c.spec, texMap, textures, texOf),
    })),
  }
}

/** Unwrap a `{ user, value }`-style animated property object to its raw value. */
function propValue(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v.value : v
}

/** Parse a signed `"x y"` (prefix of `"x y z"`) scene string into a pair. */
function parseVec2(value) {
  const m = /^(-?[\d.]+) (-?[\d.]+)/.exec(String(propValue(value) ?? ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Parse a `"w h"` scene string into a number pair. */
function parseSize(value) {
  const m = /^([\d.]+) ([\d.]+)/.exec(String(propValue(value) ?? ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Effective visibility of a scene object (handles the `{ user, value }` form). */
function isVisible(obj) {
  const v = obj.visible
  if (v && typeof v === 'object') return v.value !== false
  return v !== false
}

/**
 * Composite a scene wallpaper (puppet rig and/or particle systems) onto its
 * orthogonal projection canvas.
 *
 * Coordinate model (validated against TEX headers + MDL meshes of 3719111841):
 * scene.json "origin" places the layer's image center in the parent's local
 * space; root layers use screen coords with y pointing up from the bottom
 * edge; `local = T(origin) * Rz(angles.z) * S(scale)`; and for attached
 * children `child.world = parent.world * boneWorld[att.bone] * att.transform *
 * child.local` where boneWorld accumulates the parent puppet's bind-pose bone
 * transforms. Puppet layers draw their MDL mesh (bind-pose vertices need no
 * skinning); other layers draw their texture as a card with the authored
 * image (TEXI imgW×imgH, centered in the padded texture) filling the object's
 * declared size. Particle objects then stamp their steady state on top (see
 * the particle section below; particles over art matches every surveyed
 * wallpaper's document order).
 * @param {{ entries: { path: string, offset: number, size: number }[] }} pkg Parsed container.
 * @param {(entry: { path: string, offset: number, size: number }) => Buffer} readEntry Entry reader.
 * @param {string} weAssetsDir Wallpaper Engine `assets` directory; particle
 *   materials may reference shared textures that live only there.
 * @param {number} seed Deterministic sampling seed (the workshop id).
 * @returns {{ data: Buffer, contentType: string, anim: object | null, flat: Buffer | null,
 *   videos: { w: number, h: number, videos: object[] } | null } | null}
 *   Composite PNG (steady-state particles baked in), the animation export, the
 *   flat art frame (image layers without particles/videos, exported when
 *   particle systems or video layers are usable) and the MP4 video export
 *   (projection size + per-layer matrix, quad size, opacity, colorkey,
 *   colorBlendMode) — or null when the scene has no puppet rig, particle
 *   objects, lightshafts or video layers, has an unusable projection, or
 *   exceeds the overdraw budget — callers fall back to single-layer
 *   extraction. Layer opacity multiplies
 *   every ancestor's alpha, matching Wallpaper Engine's subtree compositing.
 */
function compositeScene(pkg, readEntry, weAssetsDir, seed) {
  const find = (p) => pkg.entries.find((e) => e.path === p)
  const readJson = (p) => {
    const e = find(p)
    if (!e) return null
    try {
      return JSON.parse(readEntry(e).toString('utf8'))
    } catch {
      return null
    }
  }

  const scene = readJson('scene.json')
  const objects = Array.isArray(scene?.objects) ? scene.objects : []
  if (objects.length === 0) return null

  const byId = new Map(objects.map((o) => [o.id, o]))
  const modelOf = (ref) => (typeof ref === 'string' ? readJson(normalizeRef(ref)) : null)

  const ancestorVisible = (obj, depth = 0) => {
    if (depth > 16) return true
    if (!isVisible(obj)) return false
    if (obj.parent == null) return true
    const parent = byId.get(obj.parent)
    return parent ? ancestorVisible(parent, depth + 1) : true
  }

  /**
   * Ancestor opacity product (own alpha excluded). Wallpaper Engine
   * composites a child with every ancestor's alpha — the shipped Media Info
   * template keeps its whole UI subtree at parent alpha 0 and animates the
   * parent on hover, so ignoring the chain paints hidden UI as ghost panels.
   */
  const ancestorAlpha = (obj, depth = 0) => {
    if (depth > 16 || obj.parent == null) return 1
    const parent = byId.get(obj.parent)
    if (!parent) return 1
    const a = propValue(parent.alpha)
    return (typeof a === 'number' ? a : 1) * ancestorAlpha(parent, depth + 1)
  }

  /** MP4 payload sniff at the first mipmap's data offset (box size + "ftyp"). */
  const texIsMp4 = (raw, tex) =>
    raw.toString('latin1', tex.dataOffset + 4, tex.dataOffset + 8) === 'ftyp'

  const videoInfoCache = new Map()

  /**
   * Resolve an image object's material texture when it is an embedded MP4
   * video (Wallpaper Engine stores chroma-keyed video layers as TEX-wrapped
   * H.264; decoding them as pixels renders RGB noise). Returns the MP4 bytes
   * plus the quad size from the model (falling back to texture dimensions).
   * @param {string} modelRef Model reference of the image object.
   * @returns {{ mp4: Buffer, w: number, h: number } | null} Video info, or
   *   null when the model is absent or its texture is not an MP4 payload.
   */
  const videoOf = (modelRef) => {
    if (videoInfoCache.has(modelRef)) return videoInfoCache.get(modelRef)
    let info = null
    const model = modelOf(modelRef)
    const matRef = typeof model?.material === 'string' ? model.material : ''
    const mat = matRef ? readJson(normalizeRef(matRef)) : null
    const texName = mat?.passes?.[0]?.textures?.[0]
    if (typeof texName === 'string') {
      for (const c of [`materials/${texName}.tex`, `materials/${texName}`, `${texName}.tex`, texName]) {
        const e = find(c)
        if (!e) continue
        const raw = readEntry(e)
        let tex = null
        try {
          tex = parseTex(raw)
        } catch {
          break
        }
        if (texIsMp4(raw, tex)) {
          const w = Number(propValue(model.width)) || tex.w
          const h = Number(propValue(model.height)) || tex.h
          info = { mp4: raw.subarray(tex.dataOffset, tex.dataOffset + tex.byteCount), w, h }
        }
        break
      }
    }
    videoInfoCache.set(modelRef, info)
    return info
  }

  /**
   * Colorkey (chroma-key) effect of an image object: the live overlay keys
   * the video's background out with the authored key color, tolerance and
   * fuzziness. Effects with `visible: false` are ignored like WE does.
   * @param {object} o Scene object.
   * @returns {{ color: number[], tolerance: number, fuzziness: number, alpha: number } | null}
   */
  const colorkeyOf = (o) => {
    for (const ef of Array.isArray(o.effects) ? o.effects : []) {
      if (ef?.visible === false) continue
      if (!/colorkey/i.test(String(ef.file ?? ''))) continue
      const cv = ef.passes?.[0]?.constantshadervalues ?? {}
      const color = parseVec3(cv.color, null)
      if (!color) return null
      return {
        color,
        tolerance: Number(cv.tolerance ?? 0),
        fuzziness: Number(cv.fuzziness ?? 0),
        alpha: Number(cv.alpha ?? 0),
      }
    }
    return null
  }

  // Puppet detection: any object naming an attachment point, or any visible
  // image object whose model declares a puppet skeleton.
  let rigged = false
  for (const o of objects) {
    if (typeof o.attachment === 'string' && o.attachment) { rigged = true; break }
    if (typeof o.image === 'string' && isVisible(o) && modelOf(o.image)?.puppet) { rigged = true; break }
  }
  const particleObjs = objects.filter(
    (o) => typeof o.particle === 'string' && o.particle && isVisible(o) && ancestorVisible(o),
  )
  // Lightshafts DIRECTDRAW shape-quads: procedural volumetric beams on an
  // image-less `shape: "quad"` object. They carry no image, so the image loop
  // below must not skip them — they render in document order like any layer.
  const shaftMap = new Map()
  for (const o of objects) {
    if (typeof o.image === 'string' || !isVisible(o) || !ancestorVisible(o)) continue
    for (const ef of Array.isArray(o.effects) ? o.effects : []) {
      if (ef?.visible === false) continue
      if (!/lightshafts/i.test(String(ef.file ?? ''))) continue
      const pass = ef.passes?.[0]
      // DIRECTDRAW=0 applies the effect to the object's own texture — that is
      // an image-object variant which the plain image path already renders
      // without the effect; only the procedural beam variant is ported.
      if (!pass || pass.combos?.DIRECTDRAW !== 1) continue
      shaftMap.set(o, pass)
      break
    }
  }
  // MP4 video layers keep a scene alive without puppet/particles/shafts.
  const videoObjs = objects.filter(
    (o) => typeof o.image === 'string' && o.image && isVisible(o) && ancestorVisible(o) && videoOf(o.image),
  )
  if (!rigged && particleObjs.length === 0 && shaftMap.size === 0 && videoObjs.length === 0) return null

  const proj = scene.general?.orthogonalprojection ?? {}
  const W = Math.round(Number(propValue(proj.width)) || 0)
  const H = Math.round(Number(propValue(proj.height)) || 0)
  if (W < MIN_ART_WIDTH || H < MIN_ART_HEIGHT || W > 8192 || H > 8192) return null

  // WE's authored clearcolor is an "r g b" triple; its default is grey.
  const cc = /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(String(propValue(scene.general?.clearcolor) ?? ''))
  const clearColor = cc ? [Number(cc[1]), Number(cc[2]), Number(cc[3])] : [0.7, 0.7, 0.7]
  const canvas = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const ci = i * 4
    canvas[ci] = clamp255(clearColor[0] * 255)
    canvas[ci + 1] = clamp255(clearColor[1] * 255)
    canvas[ci + 2] = clamp255(clearColor[2] * 255)
    canvas[ci + 3] = 255
  }

  const mdlCache = new Map()
  const puppetOf = (modelRef) => {
    if (mdlCache.has(modelRef)) return mdlCache.get(modelRef)
    let mdl = null
    const model = modelOf(modelRef)
    if (typeof model?.puppet === 'string' && model.puppet) {
      const e = find(normalizeRef(model.puppet))
      if (e) {
        try {
          mdl = parseMdl(readEntry(e))
        } catch {
          mdl = null // broken skeleton: render as a plain image quad
        }
      }
    }
    mdlCache.set(modelRef, mdl)
    return mdl
  }

  const textureOf = (modelRef) => {
    const model = modelOf(modelRef)
    const matRef = typeof model?.material === 'string' ? model.material : ''
    const mat = matRef ? readJson(normalizeRef(matRef)) : null
    const texName = mat?.passes?.[0]?.textures?.[0]
    if (typeof texName !== 'string') return null
    for (const c of [`materials/${texName}.tex`, `materials/${texName}`, `${texName}.tex`, texName]) {
      const e = find(c)
      if (!e) continue
      try {
        return texToRgba(readEntry(e))
      } catch {
        return null
      }
    }
    return null
  }

  /** Nearest ancestor (starting at `obj`) that carries a puppet model. */
  const puppetAncestor = (obj, depth = 0) => {
    if (depth > 16 || obj == null) return null
    if (typeof obj.image === 'string') {
      const mdl = puppetOf(obj.image)
      if (mdl) return { obj, mdl }
    }
    return obj.parent != null ? puppetAncestor(byId.get(obj.parent), depth + 1) : null
  }

  const localOf = (obj) => {
    const origin = parseVec2(obj.origin) ?? [0, 0]
    const scale = parseVec2(obj.scale) ?? [1, 1]
    const ang = /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(String(propValue(obj.angles) ?? ''))
    const z = ang ? Number(ang[3]) : 0
    const cos = Math.cos(z), sin = Math.sin(z)
    return {
      a: scale[0] * cos, b: scale[0] * sin, c: -scale[1] * sin, d: scale[1] * cos,
      e: origin[0], f: origin[1],
    }
  }

  const worldCache = new Map()
  const worldOf = (obj, depth = 0) => {
    if (depth > 24) return IDENT
    if (worldCache.has(obj.id)) return worldCache.get(obj.id)
    const local = localOf(obj)
    let world = local
    if (obj.parent != null) {
      const parent = byId.get(obj.parent)
      if (parent) {
        world = matMul(worldOf(parent, depth + 1), local)
        if (typeof obj.attachment === 'string' && obj.attachment) {
          const anc = puppetAncestor(parent)
          const att = anc?.mdl.atts.get(obj.attachment)
          if (att && att.bone < anc.mdl.boneWorld.length) {
            const anchor = matMul(anc.mdl.boneWorld[att.bone], att.local)
            world = matMul(matMul(worldOf(anc.obj, depth + 1), anchor), local)
          }
        }
      }
    }
    worldCache.set(obj.id, world)
    return world
  }

  // Scene y-up coords → canvas y-down pixels.
  const FLIP = { a: 1, b: 0, c: 0, d: -1, e: 0, f: H }

  const sampleTex = (rgba, tw, th, u, v, out) => {
    let fx = u * tw - 0.5
    let fy = v * th - 0.5
    fx = fx < 0 ? 0 : fx > tw - 1 ? tw - 1 : fx
    fy = fy < 0 ? 0 : fy > th - 1 ? th - 1 : fy
    const x0 = fx | 0, y0 = fy | 0
    const x1 = x0 + 1 < tw ? x0 + 1 : x0
    const y1 = y0 + 1 < th ? y0 + 1 : y0
    const gx = fx - x0, gy = fy - y0
    const i00 = (y0 * tw + x0) * 4, i10 = (y0 * tw + x1) * 4
    const i01 = (y1 * tw + x0) * 4, i11 = (y1 * tw + x1) * 4
    const w00 = (1 - gx) * (1 - gy), w10 = gx * (1 - gy), w01 = (1 - gx) * gy, w11 = gx * gy
    out[0] = rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11
    out[1] = rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11
    out[2] = rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11
    out[3] = rgba[i00 + 3] * w00 + rgba[i10 + 3] * w10 + rgba[i01 + 3] * w01 + rgba[i11 + 3] * w11
  }

  /** Reused [r, g, b] output slot for applyColorBlend. */
  const BLEND_SCRATCH = [0, 0, 0]

  /** Rasterize a puppet mesh's triangles through M (mesh y-up → canvas). */
  const paintPuppetMesh = (mdl, tex, M, opacity, blend = 0) => {
    const { rgba, w: tw, h: th } = tex
    const { verts, indices } = mdl
    const sample = [0, 0, 0, 0]
    let painted = 0
    for (let t = 0; t < indices.length; t += 3) {
      const A = verts[indices[t]], B = verts[indices[t + 1]], C = verts[indices[t + 2]]
      const a = apply(M, A.x, A.y), b = apply(M, B.x, B.y), c = apply(M, C.x, C.y)
      const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
      if (Math.abs(area2) < 1e-9) continue
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
      const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
      const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
      if (maxX < minX || maxY < minY) continue
      const s = area2 > 0 ? 1 : -1
      for (let cy = minY; cy <= maxY; cy++) {
        const py = cy + 0.5
        for (let cx = minX; cx <= maxX; cx++) {
          const pxx = cx + 0.5
          const w0 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (pxx - b[0])) * s
          if (w0 < 0) continue
          const w1 = ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (pxx - c[0])) * s
          if (w1 < 0) continue
          const w2 = 1 - w0 / (area2 * s) - w1 / (area2 * s)
          if (w2 < 0) continue
          const inv = 1 / (area2 * s)
          const n0 = w0 * inv, n1 = w1 * inv, n2 = 1 - n0 - n1
          const uu = n0 * A.u + n1 * B.u + n2 * C.u
          const vv = n0 * A.v + n1 * B.v + n2 * C.v
          sampleTex(rgba, tw, th, uu, vv, sample)
          const alpha = (sample[3] / 255) * opacity
          if (blend !== 5 && blend !== 10 && alpha <= 0.004) continue
          const ci = (cy * W + cx) * 4
          if (blend) {
            applyColorBlend(blend, canvas[ci], canvas[ci + 1], canvas[ci + 2], sample[0], sample[1], sample[2], alpha, BLEND_SCRATCH)
            canvas[ci] = BLEND_SCRATCH[0]
            canvas[ci + 1] = BLEND_SCRATCH[1]
            canvas[ci + 2] = BLEND_SCRATCH[2]
          } else {
            const ia = 1 - alpha
            canvas[ci] = sample[0] * alpha + canvas[ci] * ia
            canvas[ci + 1] = sample[1] * alpha + canvas[ci + 1] * ia
            canvas[ci + 2] = sample[2] * alpha + canvas[ci + 2] * ia
          }
          painted++
        }
      }
    }
    return painted
  }

  /** Paint a card layer's texture through T (tex top-left px → canvas px). */
  const paintLayer = (tex, T, opacity, blend = 0) => {
    const inv = matInv(T)
    const { rgba, w: tw, h: th } = tex
    const cs = [apply(T, 0, 0), apply(T, tw, 0), apply(T, 0, th), apply(T, tw, th)]
    const minX = Math.max(0, Math.floor(Math.min(cs[0][0], cs[1][0], cs[2][0], cs[3][0])))
    const maxX = Math.min(W - 1, Math.ceil(Math.max(cs[0][0], cs[1][0], cs[2][0], cs[3][0])))
    const minY = Math.max(0, Math.floor(Math.min(cs[0][1], cs[1][1], cs[2][1], cs[3][1])))
    const maxY = Math.min(H - 1, Math.ceil(Math.max(cs[0][1], cs[1][1], cs[2][1], cs[3][1])))
    if (maxX < minX || maxY < minY) return 0
    const identity = Math.abs(T.a - 1) < 1e-9 && Math.abs(T.b) < 1e-9 && Math.abs(T.c) < 1e-9 && Math.abs(T.d - 1) < 1e-9
    let painted = 0
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        let ix, iy
        if (identity) {
          ix = cx - T.e
          iy = cy - T.f
          if (ix < 0 || iy < 0 || ix >= tw || iy >= th) continue
          const ii = ((iy | 0) * tw + (ix | 0)) * 4
          const alpha = (rgba[ii + 3] / 255) * opacity
          if (blend !== 5 && blend !== 10 && alpha <= 0.004) continue
          const ci = (cy * W + cx) * 4
          if (blend) {
            applyColorBlend(blend, canvas[ci], canvas[ci + 1], canvas[ci + 2], rgba[ii], rgba[ii + 1], rgba[ii + 2], alpha, BLEND_SCRATCH)
            canvas[ci] = BLEND_SCRATCH[0]
            canvas[ci + 1] = BLEND_SCRATCH[1]
            canvas[ci + 2] = BLEND_SCRATCH[2]
          } else {
            const ia = 1 - alpha
            canvas[ci] = rgba[ii] * alpha + canvas[ci] * ia
            canvas[ci + 1] = rgba[ii + 1] * alpha + canvas[ci + 1] * ia
            canvas[ci + 2] = rgba[ii + 2] * alpha + canvas[ci + 2] * ia
          }
          painted++
          continue
        }
        ix = inv.a * cx + inv.c * cy + inv.e
        iy = inv.b * cx + inv.d * cy + inv.f
        if (ix < -0.5 || iy < -0.5 || ix > tw + 0.5 || iy > th + 0.5) continue
        const xf = ix < 0 ? 0 : ix > tw - 1 ? tw - 1 : ix
        const yf = iy < 0 ? 0 : iy > th - 1 ? th - 1 : iy
        const x0 = xf | 0, y0 = yf | 0
        const x1 = x0 + 1 < tw ? x0 + 1 : x0
        const y1 = y0 + 1 < th ? y0 + 1 : y0
        const fx = xf - x0, fy = yf - y0
        const i00 = (y0 * tw + x0) * 4, i10 = (y0 * tw + x1) * 4
        const i01 = (y1 * tw + x0) * 4, i11 = (y1 * tw + x1) * 4
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
        const alpha = (rgba[i00 + 3] * w00 + rgba[i10 + 3] * w10 + rgba[i01 + 3] * w01 + rgba[i11 + 3] * w11) / 255 * opacity
        if (blend !== 5 && blend !== 10 && alpha <= 0.004) continue
        const ci = (cy * W + cx) * 4
        if (blend) {
          applyColorBlend(blend, canvas[ci], canvas[ci + 1], canvas[ci + 2],
            rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11,
            rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11,
            rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11,
            alpha, BLEND_SCRATCH)
          canvas[ci] = BLEND_SCRATCH[0]
          canvas[ci + 1] = BLEND_SCRATCH[1]
          canvas[ci + 2] = BLEND_SCRATCH[2]
        } else {
          const ia = 1 - alpha
          canvas[ci] = (rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11) * alpha + canvas[ci] * ia
          canvas[ci + 1] = (rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11) * alpha + canvas[ci + 1] * ia
          canvas[ci + 2] = (rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11) * alpha + canvas[ci + 2] * ia
        }
        painted++
      }
    }
    return painted
  }

  // ── particle systems (closures over canvas/W/H/readEntry) ────────────────

  /** Particle texture cache: material ref → decoded tex + blending mode. */
  const particleTexCache = new Map()

  /**
   * Resolve a particle material's texture: pkg entries first, then the shared
   * Wallpaper Engine asset library (particle materials commonly reference
   * built-in textures that never ship inside the pkg).
   * @returns {{ rgba: Buffer, w: number, h: number, frames: object[] | null,
   *   blending: string } | null}
   */
  const particleTextureOf = (matRef) => {
    if (particleTexCache.has(matRef)) return particleTexCache.get(matRef)
    let result = null
    const mat = readJson(normalizeRef(matRef))
    const pass = mat?.passes?.[0]
    const texName = pass?.textures?.[0]
    if (typeof texName === 'string' && !texName.startsWith('_rt_')) {
      const blending = pass.blending === 'additive' ? 'additive' : 'translucent'
      let tex = null
      for (const c of [`materials/${texName}.tex`, `materials/${texName}`, `${texName}.tex`, texName]) {
        const e = find(c)
        if (!e) continue
        try {
          tex = texToRgba(readEntry(e))
        } catch {
          tex = null
        }
        break
      }
      if (!tex && weAssetsDir) {
        const assetPath = path.join(weAssetsDir, 'materials', `${texName}.tex`)
        if (fs.existsSync(assetPath)) {
          try {
            tex = texToRgba(fs.readFileSync(assetPath))
          } catch {
            tex = null
          }
        }
      }
      if (tex) result = { ...tex, blending }
    }
    particleTexCache.set(matRef, result)
    return result
  }

  /** Compiled particle spec cache keyed by normalized json ref. */
  const specCache = new Map()

  /**
   * Compile one particle system json: initializer ranges, operator functions,
   * emitters and child systems. Unknown initializers/operators (control-point
   * attractors, live turbulence) have no static equivalent and are skipped.
   * @param {string} ref Particle json ref from scene.json or a parent system.
   * @returns {object | null} Compiled spec, or null when the json is absent.
   */
  const loadParticleSpec = (ref) => {
    const key = normalizeRef(ref)
    if (specCache.has(key)) return specCache.get(key)
    const raw = readJson(key)
    let spec = null
    if (raw) {
      const inits = raw.initializers ?? raw.initializer ?? []
      const ops = raw.operators ?? raw.operator ?? []
      const renderers = raw.renderers ?? raw.renderer ?? []
      const renderer = renderers.find((r) => typeof r.name === 'string') ?? null

      const init = { lifetime: [1, 1], size: [1, 1], alpha: [1, 1], color: null, vel: null, rot: null, av: null, turb: null }
      for (const j of inits) {
        switch (j.name) {
          case 'lifetimerandom': init.lifetime = [Number(j.min ?? 1), Number(j.max ?? 1)]; break
          case 'sizerandom': init.size = [Number(j.min ?? 1), Number(j.max ?? 1)]; break
          case 'alpharandom': init.alpha = [Number(j.min ?? 0.05), Number(j.max ?? 1)]; break
          case 'velocityrandom': init.vel = [parseVec3(j.min), parseVec3(j.max)]; break
          case 'rotationrandom': init.rot = [parseVec3(j.min), parseVec3(j.max)]; break
          case 'angularvelocityrandom': init.av = [parseVec3(j.min), parseVec3(j.max)]; break
          case 'colorrandom': {
            const cmin = parseVec3(j.min, [255, 255, 255]).map((v) => v / 255)
            const cmax = j.max != null ? parseVec3(j.max, [255, 255, 255]).map((v) => v / 255) : cmin
            init.color = [cmin, cmax]
            break
          }
          case 'turbulentvelocityrandom':
            init.turb = { speed: [Number(j.speedmin ?? 0), Number(j.speedmax ?? 0)], mask: parseVec3(j.mask, [1, 1, 1]) }
            break
          default: break // mapsequencearoundcontrolpoint & friends: no static equivalent
        }
      }

      const compiled = {
        alphaFns: [], sizeFns: [], colorFn: null, movement: null, angular: null,
        oscPos: null, oscAlpha: null, oscSize: null, vortex: null,
      }
      for (const j of ops) {
        switch (j.name) {
          case 'movement':
            if (!compiled.movement) compiled.movement = { gravity: parseVec3(j.gravity), drag: Number(j.drag ?? 0) }
            break
          case 'angularmovement':
            if (!compiled.angular) compiled.angular = { force: parseVec3(j.force)[2], drag: Number(j.drag ?? 0) }
            break
          case 'alphafade': {
            const fin = Number(j.fadeintime ?? 0.5)
            const fout = Number(j.fadeouttime ?? 0.5)
            compiled.alphaFns.push((t) => alphaFade(t, fin, fout))
            break
          }
          case 'alphachange': {
            const vc = readValueChange(j)
            compiled.alphaFns.push((t) => fadeValueChange(t, vc))
            break
          }
          case 'sizechange': {
            const vc = readValueChange(j)
            compiled.sizeFns.push((t) => fadeValueChange(t, vc))
            break
          }
          case 'colorchange': {
            const vc = readValueChange(j)
            const from = parseVec3(j.startvalue, [1, 1, 1])
            const to = parseVec3(j.endvalue, [1, 1, 1])
            compiled.colorFn = (t) => {
              const k = fadeValueChange(t, vc)
              return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k]
            }
            break
          }
          case 'oscillatealpha': compiled.oscAlpha = readFrequency(j); break
          case 'oscillatesize': compiled.oscSize = readFrequency(j); break
          case 'oscillateposition': compiled.oscPos = readFrequency(j); break
          case 'vortex':
            if (!compiled.vortex) {
              compiled.vortex = {
                origin: parseVec3(j.offset),
                speedInner: Number(j.speedinner ?? 0), speedOuter: Number(j.speedouter ?? 0),
                distInner: Number(j.distanceinner ?? 0), distOuter: Number(j.distanceouter ?? 0),
              }
            }
            break
          default: break // turbulence/controlpointattract: no static equivalent (documented omission)
        }
      }

      // WE semantics: boxrandom emits uniformly inside [distancemin, distancemax];
      // sphererandom emits at radius cbrt(U)∈[rmin,rmax] with a masked random direction.
      const emitters = (raw.emitter ?? []).map((j) => ({
        name: j.name,
        rate: Number(j.rate ?? 0),
        distmin: parseVec3(j.distancemin), distmax: parseVec3(j.distancemax),
        origin: parseVec3(j.origin), directions: parseVec3(j.directions, [1, 1, 1]),
        sign: parseVec3(j.sign).map((v) => Math.round(v)),
        speedmin: Number(j.speedmin ?? 0), speedmax: Number(j.speedmax ?? 0),
        instantaneous: Number(j.instantaneous ?? 0),
        box: j.name === 'boxrandom',
      }))

      spec = {
        ref: key, init, ops: compiled, emitters,
        rate: emitters.reduce((s, e) => s + e.rate, 0),
        instantaneous: emitters.reduce((s, e) => Math.max(s, e.instantaneous), 0),
        maxcount: Number(raw.maxcount ?? 0),
        starttime: Number(raw.starttime ?? 0),
        animationmode: raw.animationmode ?? 'sequence',
        seqx: Number(raw.sequencemultiplier ?? 1),
        renderer: renderer ? { name: renderer.name, length: Number(renderer.length ?? 0) } : null,
        material: typeof raw.material === 'string' ? raw.material : null,
        children: (raw.children ?? []).map((c) => ({
          spec: loadParticleSpec(c.name),
          origin: parseVec3(c.origin),
          type: c.type ?? 'static',
        })),
      }
    }
    specCache.set(key, spec)
    return spec
  }

  /**
   * Paint one particle sprite. Local-space quad: width = size, height =
   * size*aspect (reference shader: half-extent = size/2, v axis scaled by the
   * frame aspect), rotated by `rot` (radians, CCW in the y-up local space),
   * image top edge along +up. Sampled bilinear from the frame rect with clamp
   * addressing; RGB tinted by particle color; additive or translucent blend.
   * @returns {number} Pixels painted.
   */
  const paintParticleSprite = (texInfo, frame, M, cx, cy, size, rot, tint, alpha, additive) => {
    const aspect = frame ? frame.aspect : texInfo.h / texInfo.w
    const w = size
    const h = size * aspect
    const { rgba, w: tw, h: th } = texInfo
    const u0 = frame ? frame.u0 : 0
    const v0 = frame ? frame.v0 : 0
    const uSpan = frame ? frame.u1 - frame.u0 : 1
    const vSpan = frame ? frame.v1 - frame.v0 : 1
    const cos = Math.cos(rot), sin = Math.sin(rot)
    const corners = []
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const lx = cx + cos * (u - 0.5) * w + sin * (v - 0.5) * h
      const ly = cy + sin * (u - 0.5) * w - cos * (v - 0.5) * h
      corners.push(apply(M, lx, ly))
    }
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))))
    const maxX = Math.min(W - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))))
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))))
    const maxY = Math.min(H - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))))
    if (maxX < minX || maxY < minY) return 0
    const inv = matInv(M)
    const axisAligned = Math.abs(M.b) < 1e-9 && Math.abs(M.c) < 1e-9 && Math.abs(rot) < 1e-6
    let paintedPx = 0
    for (let cy2 = minY; cy2 <= maxY; cy2++) {
      for (let cx2 = minX; cx2 <= maxX; cx2++) {
        let u, v
        if (axisAligned) {
          // M maps local→canvas with scale/translate only: invert directly.
          const lxx = (cx2 - M.e) / M.a
          const lyy = (cy2 - M.f) / M.d
          u = (lxx - cx) / w + 0.5
          v = 0.5 - (lyy - cy) / h
        } else {
          const [lx, ly] = apply(inv, cx2, cy2)
          const dx = lx - cx
          const dy = ly - cy
          u = 0.5 + (dx * cos + dy * sin) / w
          v = 0.5 + (dx * sin - dy * cos) / h
        }
        if (u < 0 || u > 1 || v < 0 || v > 1) continue
        let fx = (u0 + u * uSpan) * tw - 0.5
        let fy = (v0 + v * vSpan) * th - 0.5
        fx = fx < 0 ? 0 : fx > tw - 1 ? tw - 1 : fx
        fy = fy < 0 ? 0 : fy > th - 1 ? th - 1 : fy
        const x0 = fx | 0, y0 = fy | 0
        const x1 = x0 + 1 < tw ? x0 + 1 : x0
        const y1 = y0 + 1 < th ? y0 + 1 : y0
        const gx = fx - x0, gy = fy - y0
        const i00 = (y0 * tw + x0) * 4, i10 = (y0 * tw + x1) * 4
        const i01 = (y1 * tw + x0) * 4, i11 = (y1 * tw + x1) * 4
        const w00 = (1 - gx) * (1 - gy), w10 = gx * (1 - gy), w01 = (1 - gx) * gy, w11 = gx * gy
        const sr = (rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11) * tint[0]
        const sg = (rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11) * tint[1]
        const sb = (rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11) * tint[2]
        const sa = ((rgba[i00 + 3] * w00 + rgba[i10 + 3] * w10 + rgba[i01 + 3] * w01 + rgba[i11 + 3] * w11) / 255) * alpha
        if (sa <= 0.004) continue
        const ci = (cy2 * W + cx2) * 4
        if (additive) {
          canvas[ci] = Math.min(255, canvas[ci] + sr * sa)
          canvas[ci + 1] = Math.min(255, canvas[ci + 1] + sg * sa)
          canvas[ci + 2] = Math.min(255, canvas[ci + 2] + sb * sa)
        } else {
          const ia = 1 - sa
          canvas[ci] = sr * sa + canvas[ci] * ia
          canvas[ci + 1] = sg * sa + canvas[ci + 1] * ia
          canvas[ci + 2] = sb * sa + canvas[ci + 2] * ia
        }
        paintedPx++
      }
    }
    return paintedPx
  }

  /** Remaining sprite stamps this composite may draw (cost cap). */
  let spriteBudget = MAX_PARTICLE_SPRITES

  /**
   * Draw one sampled particle set through M (system-local → canvas).
   * @returns {number} Pixels painted.
   */
  const drawParticleSet = (spec, particles, M, baseAlpha, texInfo) => {
    const frames = texInfo.frames
    const additive = texInfo.blending === 'additive'
    // rope renderers strand sprites oldest→newest; alpha-descending stamp
    // order approximates that layering for the static frame.
    const isRope = spec.renderer?.name === 'rope' || spec.renderer?.name === 'ropetrail'
    const drawn = []
    for (const p of particles) {
      const st = particleStateAt(spec, p)
      if (st.alpha <= 0.004 || st.size <= 0.5) continue
      const pos = p.traj(p.age)
      const frame = frames ? frames[frameIndexOf(spec, p, frames)] : null
      drawn.push({ x: pos[0] + p.osc.offX, y: pos[1] + p.osc.offY, size: st.size, alpha: st.alpha, color: st.color, rot: st.rot, frame })
    }
    if (isRope) drawn.sort((a, b) => b.alpha - a.alpha)
    let count = 0
    for (const d of drawn) {
      if (spriteBudget-- <= 0) break
      count += paintParticleSprite(texInfo, d.frame, M, d.x, d.y, d.size, d.rot, d.color, d.alpha * baseAlpha, additive)
    }
    return count
  }

  /**
   * Walk one particle system (and its children) rooted at a scene object.
   * `M` maps the root system's local space to canvas; `offset` translates
   * within that space (STATIC child origins accumulate).
   * @returns {number} Pixels painted.
   */
  const walkParticleSystem = (spec, M, baseAlpha, offset, rng, depth = 0) => {
    if (!spec || depth > 8) return 0
    if (offset[0] || offset[1]) M = matMul(M, { a: 1, b: 0, c: 0, d: 1, e: offset[0], f: offset[1] })
    const hasEventChildren = spec.children.some((c) => c.type !== 'static' && c.spec)
    const texInfo = spec.renderer && spec.material ? particleTextureOf(spec.material) : null
    const own = []
    if ((spec.renderer && texInfo) || hasEventChildren) {
      const n = steadyCount(spec)
      for (let i = 0; i < n; i++) own.push(sampleParticle(spec, rng, null))
    }
    let paintedPx = 0
    if (spec.renderer && texInfo && own.length) {
      paintedPx = drawParticleSet(spec, own, M, baseAlpha, texInfo)
    }
    for (const c of spec.children) {
      if (!c.spec) continue
      if (c.type === 'static') {
        paintedPx += walkParticleSystem(c.spec, M, baseAlpha, [offset[0] + c.origin[0], offset[1] + c.origin[1]], rng, depth + 1)
      } else {
        // Event children: one instance per parent particle, spawned on the
        // parent's trajectory (eventfollow along the path, eventspawn at the
        // spawn point, eventdeath at the death point).
        const childTex = c.spec.renderer && c.spec.material ? particleTextureOf(c.spec.material) : null
        if (!childTex) continue
        for (const parent of own) {
          const windowAge = c.type === 'eventdeath' ? parent.L : parent.age
          const n = steadyCount(c.spec, windowAge)
          if (n <= 0) continue
          const kids = []
          for (let i = 0; i < n; i++) {
            const kid = sampleParticle(c.spec, rng, null)
            const age01 = rng()
            const kAge = Math.min(age01 * kid.L, windowAge)
            const spawnAge = c.type === 'eventfollow' ? parent.age - kAge : c.type === 'eventspawn' ? 0 : parent.L
            const sp = parent.traj(Math.max(0, spawnAge))
            const em = c.spec.emitters[0]
            const emPos = em ? sampleEmitterPos(c.spec, rng) : [0, 0]
            const st = sampleInitState(c.spec, rng)
            let vel = st.vel
            if (!c.spec.init.vel && em && (em.speedmin !== 0 || em.speedmax !== 0)) {
              const len = Math.hypot(sp[0], sp[1])
              if (len > 1e-6) {
                const speed = randRange(rng, em.speedmin, em.speedmax)
                vel = [(speed * sp[0]) / len, (speed * sp[1]) / len]
              }
            }
            kids.push({
              L: kid.L, age01: kAge / kid.L, age: kAge,
              size0: kid.size0, alpha0: kid.alpha0, color0: kid.color0, rot0: kid.rot0, av: kid.av, frameRoll: kid.frameRoll,
              traj: buildTraj(c.spec, [sp[0] + emPos[0], sp[1] + emPos[1]], vel, rng),
              osc: kid.osc,
            })
          }
          paintedPx += drawParticleSet(c.spec, kids, M, baseAlpha, childTex)
        }
      }
    }
    return paintedPx
  }

  // ── lightshafts beams (closures over canvas/W/H/find/readEntry) ──────────

  /** Lightshaft texture cache: shader texture name → decoded RGBA. */
  const beamTexCache = new Map()

  /**
   * Resolve a lightshafts shader texture by name (pkg entries first, then the
   * shared Wallpaper Engine asset library — the noise and gradient defaults
   * live only there).
   * @param {string} name Shader texture name, e.g. `util/noise`.
   * @returns {{ rgba: Buffer, w: number, h: number } | null}
   */
  const beamTextureOf = (name) => {
    if (beamTexCache.has(name)) return beamTexCache.get(name)
    let tex = null
    for (const c of [`materials/${name}.tex`, `materials/${name}.png`, `${name}.tex`, `${name}.png`]) {
      const e = find(c)
      if (!e) continue
      try {
        tex = c.endsWith('.png') ? decodePng(readEntry(e)) : texToRgba(readEntry(e))
      } catch {
        tex = null
      }
      break
    }
    if (!tex && weAssetsDir) {
      for (const ext of ['.tex', '.png']) {
        const assetPath = path.join(weAssetsDir, 'materials', `${name}${ext}`)
        if (!fs.existsSync(assetPath)) continue
        try {
          tex = ext === '.png' ? decodePng(fs.readFileSync(assetPath)) : texToRgba(fs.readFileSync(assetPath))
        } catch {
          tex = null
        }
        break
      }
    }
    beamTexCache.set(name, tex)
    return tex
  }

  /**
   * Number uniform with the shader's default. The scene stores pass values in
   * `constantshadervalues` under the shader's lowercase material names.
   * @param {object} csv `constantshadervalues` of the effect pass.
   * @param {string} key Material name, e.g. `rayradius`.
   * @param {number} dflt Shader-declared default.
   * @returns {number}
   */
  const shaftNum = (csv, key, dflt) => {
    const n = Number(csv[key])
    return Number.isFinite(n) ? n : dflt
  }

  /**
   * Paint one lightshafts DIRECTDRAW beam additively onto the canvas, baked
   * at t=0 (the animated ray shimmer only scrolls the noise; the shape is
   * static). Port of assets/effects/lightshafts/shaders/effects/lightshafts.frag:
   * the shape quad's world transform maps canvas pixels to quad-local uv, the
   * perspective inverse of `squareToQuad(point0..3)` yields the ray
   * coordinates, and the shader's `ApplyBlending(31, 0, …)` output through
   * the engine's additive (SRC_ALPHA, ONE) hardware blend contributes
   * `fxColor·intensity·fx²` per pixel.
   * @param {object} o Scene object carrying the effect.
   * @param {object} pass First effect pass (`combos` + `constantshadervalues`).
   * @returns {number} Pixels touched.
   */
  const paintLightshaft = (o, pass) => {
    const csv = pass.constantshadervalues ?? {}
    const combos = pass.combos ?? {}
    const mode = combos.RAYMODE ?? 0
    const rendering = combos.RENDERING ?? 0
    const corner = combos.RAYCORNER ?? 0
    const p0 = parseVec2(csv.point0), p1 = parseVec2(csv.point1)
    const p2 = parseVec2(csv.point2), p3 = parseVec2(csv.point3)
    if (!p0 || !p1 || !p2 || !p3) return 0
    const Minv = mat3Inv(squareToQuad(p0, p1, p2, p3))
    if (!Minv) return 0
    const rayScale = parseVec2(csv.rayscale) ?? [0.5, 0.1]
    const feather = parseVec2(csv.rayfeather) ?? [0.05, 0.2]
    const smoothness = shaftNum(csv, 'raysmoothness', 0.75)
    const radius = shaftNum(csv, 'rayradius', 0.2)
    const noiseScale = shaftNum(csv, 'noisescale', 1)
    const noiseAmount = shaftNum(csv, 'noiseamount', 0.33)
    const intensity = shaftNum(csv, 'colorwintensity', 1)
    const exponent = shaftNum(csv, 'colorwexponent', 1)
    const startAngle = shaftNum(csv, 'rayzstartangle', 0)
    const endAngle = shaftNum(csv, 'rayzzendangle', 1)
    // No surveyed lightshafts instance overrides the shader's texture slots,
    // so the declared defaults are used directly.
    const noise = beamTextureOf('util/noise')
    const grad = rendering === 1 ? beamTextureOf('gradient/gradient_iridescent') : null
    if (!noise || (rendering === 1 && !grad)) return 0
    const colStart = parseVec3(csv.colorastart) ?? [1, 1, 1]
    const colEnd = parseVec3(csv.colorend) ?? [0.5, 0.8, 1]
    // A size-less shape-quad spans an ortho-height square (measured on WE's
    // own rendering of 3600720818; every surveyed instance omits `size`).
    const size = parseSize(o.size) ?? [H, H]
    const world = worldOf(o)
    const det = world.a * world.d - world.b * world.c
    if (!Number.isFinite(det) || det === 0) return 0
    // Scene (y-up) → quad-local (y-up): u right, v up from the quad's center.
    const inv = matInv(world)
    const c0 = Minv[0], c1 = Minv[1], c2 = Minv[2]
    const ssA = (1 - smoothness) * 0.29999
    const ssB = 0.3 + smoothness * 0.7
    const feX = feather[0], feY = feather[1]
    const gcol = [0, 0, 0]
    let painted = 0
    for (let py = 0; py < H; py++) {
      const sy = H - py - 0.5
      const uA = inv.a / size[0]
      const uB = (inv.a * 0.5 + inv.c * sy + inv.e) / size[0] + 0.5
      const vA = -inv.b / size[1]
      const vB = 0.5 - (inv.b * 0.5 + inv.d * sy + inv.f) / size[1]
      for (let px = 0; px < W; px++) {
        const u = uA * px + uB
        const v = vA * px + vB
        const hw = u * c0[2] + v * c1[2] + c2[2]
        if (hw <= 0) continue
        let x = (u * c0[0] + v * c1[0] + c2[0]) / hw
        let y = (u * c0[1] + v * c1[1] + c2[1]) / hw
        let mask = 1
        let shapeScaleX = rayScale[0]
        const shapeScaleY = rayScale[1]
        if (mode === 1) {
          const dx = x - 0.5, dy = y - 0.5
          x = Math.atan2(dy, dx) / 6.283185307179586 + 0.5
          y = smoothstepf(radius, 1, Math.hypot(dx, dy) * 2)
          y = (y - 0.0001) * 1.00021
          shapeScaleX *= 4
          mask *= smoothstepf(startAngle - 0.00001, startAngle + feX, x)
          mask *= smoothstepf(endAngle + 0.00001, endAngle - feX, x)
          mask *= smoothstepf(0.50001, 0.5 - feY, Math.abs(y - 0.5))
        } else if (mode === 2) {
          let dx = x, dy = y
          if (corner === 1) dx = 1 - dx
          else if (corner === 2) dy = 1 - dy
          else if (corner === 3) { dy = 1 - dy; dx = 1 - dx }
          x = Math.atan2(dy, dx) / 6.283185307179586 * 4
          y = Math.max(dx, dy)
          y += sampleRedWrap(noise, x * 0.054111 * noiseScale, 0) * noiseAmount - noiseAmount * 0.5
          y = smoothstepf(radius, 1, y)
          shapeScaleX *= 4
          mask *= smoothstepf(0.50001, 0.5 - feX, Math.abs(x - 0.5))
          mask *= smoothstepf(0.50001, 0.5 - feY, Math.abs(y - 0.5))
        } else {
          mask *= smoothstepf(0.50001, 0.5 - feX, Math.abs(x - 0.5))
          mask *= smoothstepf(0.50001, 0.5 - feY, Math.abs(y - 0.5))
        }
        const refY = y
        mask *= 1 - y
        if (mask <= 0) continue
        let fx = sampleRedWrap(noise, x * 0.054111 * shapeScaleX, y * 0.003111 * shapeScaleY)
          * sampleRedWrap(noise, x * 0.07333 * shapeScaleX, y * 0.005967111 * shapeScaleY)
        fx = Math.pow(fx, exponent)
        fx = smoothstepf(ssA, ssB, fx)
        fx *= mask * intensity
        if (fx <= 0.0005) continue
        fx *= fx
        if (rendering === 1) {
          sampleRgbClamp(grad, refY, 0, gcol)
        } else {
          for (let c = 0; c < 3; c++) {
            gcol[c] = (colStart[c] + (colEnd[c] - colStart[c]) * refY) * 255
          }
        }
        const ci = (py * W + px) * 4
        canvas[ci] = clamp255(canvas[ci] + gcol[0] * fx)
        canvas[ci + 1] = clamp255(canvas[ci + 1] + gcol[1] * fx)
        canvas[ci + 2] = clamp255(canvas[ci + 2] + gcol[2] * fx)
        painted++
      }
    }
    return painted
  }

  let paintedLayers = 0
  let paintedPixels = 0
  // MP4 video layers: exported for the live overlay instead of being decoded
  // as pixels (RGB noise). They ride in document order between the flat art
  // and the particle pass — the browser composites them onto the animation
  // canvas above the flat art and below the particles. M is FLIP×world like
  // the particle systems; the video frame's v axis points down, so the client
  // y-flips the frame when stamping it (same as particle sprites).
  const videos = []
  for (const o of objects) {
    if (typeof o.image !== 'string') {
      // Lightshafts beams render in document order between the neighbouring
      // image layers (additive, so only layers above can occlude them).
      const shaftPass = shaftMap.get(o)
      if (shaftPass) {
        paintedPixels += paintLightshaft(o, shaftPass)
        if (paintedPixels > MAX_COMPOSITE_OVERDRAW * W * H) return null
      }
      continue
    }
    if (!isVisible(o) || !ancestorVisible(o)) continue
    const alpha = propValue(o.alpha)
    const opacity = (typeof alpha === 'number' ? alpha : 1) * ancestorAlpha(o)
    const video = videoOf(o.image)
    if (video) {
      if (opacity > 0 && video.mp4.length > 0) {
        const canvasM = matMul(FLIP, worldOf(o))
        if (canvasM) {
          videos.push({
            M: [canvasM.a, canvasM.b, canvasM.c, canvasM.d, canvasM.e, canvasM.f],
            w: video.w, h: video.h, opacity, key: colorkeyOf(o),
            blend: typeof o.colorBlendMode === 'number' ? o.colorBlendMode : 0,
            mp4: video.mp4,
          })
        }
      }
      continue
    }
    const tex = textureOf(o.image)
    if (!tex) continue
    const world = worldOf(o)
    if (!world) continue
    const canvasM = matMul(FLIP, world)
    const mdl = puppetOf(o.image)
    const blend = typeof o.colorBlendMode === 'number' ? o.colorBlendMode : 0
    let n = 0
    if (mdl) {
      n = paintPuppetMesh(mdl, tex, canvasM, opacity, blend)
    } else {
      const size = parseSize(o.size)
      const qw = size ? size[0] : tex.imgW
      const qh = size ? size[1] : tex.imgH
      // Authored image (imgW×imgH, centered in the padded texture) fills the
      // quad: tex pixel (px,py) → local ((px-tw/2)*qw/imgW, (th/2-py)*qh/imgH).
      const sx = qw / tex.imgW
      const sy = qh / tex.imgH
      const texToCanvas = matMul(canvasM, {
        a: sx, b: 0, c: 0, d: -sy, e: -tex.w / 2 * sx, f: tex.h / 2 * sy,
      })
      n = paintLayer(tex, texToCanvas, opacity, blend)
    }
    if (n > 0) paintedLayers++
    paintedPixels += n
    if (paintedPixels > MAX_COMPOSITE_OVERDRAW * W * H) return null
  }
  // Particle pass after the image layers: particles sit above the art in every
  // surveyed wallpaper's document order, and the deterministic seed keeps one
  // wallpaper's steady-state frame reproducible.
  const rng = mulberry32(seed)
  let particlePixels = 0
  const animSystems = []
  const animTexMap = new Map()
  const animTextures = []
  // The browser replays the particle layer live on a canvas overlay, and the
  // art under it must not carry the baked steady-state frame (double
  // particles). Snapshot the image layers before the particle pass so the
  // flat frame can be exported next to the animated systems.
  const flatCanvas = Buffer.from(canvas)
  for (const o of particleObjs) {
    const spec = applyInstanceOverride(loadParticleSpec(o.particle), o.instanceoverride)
    if (!spec) continue
    const world = worldOf(o)
    if (!world) continue
    const alpha = propValue(o.alpha)
    const opacity = (typeof alpha === 'number' ? alpha : 1) * ancestorAlpha(o)
    const M = matMul(FLIP, world)
    particlePixels += walkParticleSystem(spec, M, opacity, [0, 0], rng)
    const animSpec = exportAnimSpec(spec, animTexMap, animTextures, particleTextureOf)
    if (animSpec && (animSpec.tex != null || animSpec.children.length)) {
      animSystems.push({ M: [M.a, M.b, M.c, M.d, M.e, M.f], alpha: opacity, spec: animSpec })
    }
  }
  if (paintedLayers === 0 && particlePixels === 0 && videos.length === 0) return null
  const anim = animSystems.length && animTextures.length
    ? { w: W, h: H, systems: animSystems, textures: animTextures }
    : null
  // The flat frame (live-overlay base) excludes the video layers too: the
  // browser paints them live between the flat art and the particles.
  const videoExport = videos.length ? { w: W, h: H, videos } : null
  return {
    data: encodePng(canvas, W, H),
    contentType: 'image/png',
    anim,
    flat: anim || videoExport ? encodePng(flatCanvas, W, H) : null,
    videos: videoExport,
  }
}

/** Clamp a float color component to an 8-bit channel value. */
function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)))
}

// ── background layer resolution (fallback path) ────────────────────────────

/**
 * Resolve the scene's main background texture entry.
 *
 * Walks scene.json → the largest visible image object → its model → its
 * material → the first texture of the first pass. Falls back to the largest
 * .tex entry when the object chain is unreadable.
 * @param {{ entries: { path: string, offset: number, size: number }[] }} pkg Parsed container.
 * @param {(entry: { path: string, offset: number, size: number }) => Buffer} readEntry Entry reader.
 * @returns {{ entry: object } | null} The texture entry, or null when absent.
 */
function resolveBackgroundTex(pkg, readEntry) {
  const find = (p) => pkg.entries.find((e) => e.path === p)
  /** MP4 video payloads must not become the static background (RGB noise). */
  const isMp4Tex = (entry) => {
    const raw = readEntry(entry)
    try {
      const tex = parseTex(raw)
      return raw.toString('latin1', tex.dataOffset + 4, tex.dataOffset + 8) === 'ftyp'
    } catch {
      return false
    }
  }
  const sceneEntry = find('scene.json')
  if (sceneEntry) {
    try {
      const scene = JSON.parse(readEntry(sceneEntry).toString('utf8'))
      const objects = Array.isArray(scene.objects) ? scene.objects : []
      let best = null
      for (const o of objects) {
        if (typeof o.image !== 'string') continue
        const size = parseSize(o.size)
        const area = size ? size[0] * size[1] : 0
        const score = (isVisible(o) ? 0 : -1) * 1e12 + area
        if (!best || score > best.score) best = { o, score }
      }
      if (best) {
        const modelEntry = find(normalizeRef(best.o.image))
        if (modelEntry) {
          const model = JSON.parse(readEntry(modelEntry).toString('utf8'))
          const matEntry = find(normalizeRef(model.material ?? ''))
          if (matEntry) {
            const mat = JSON.parse(readEntry(matEntry).toString('utf8'))
            const texName = mat?.passes?.[0]?.textures?.[0]
            if (typeof texName === 'string') {
              for (const c of [`materials/${texName}.tex`, `materials/${texName}`, `${texName}.tex`, texName]) {
                const hit = find(c)
                if (hit && !isMp4Tex(hit)) return { entry: hit }
              }
            }
          }
        }
      }
    } catch { /* fall through to the largest-tex heuristic */ }
  }
  const texes = pkg.entries.filter((e) => e.path.endsWith('.tex'))
  for (const e of [...texes].sort((a, b) => b.size - a.size)) {
    if (!isMp4Tex(e)) return { entry: e }
  }
  return null
}
