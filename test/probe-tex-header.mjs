// Dump the TEX header of each scene's main layer texture.
// Usage: node probe-tex-header.mjs <workshopId> [moreIds...]
import { readFileSync } from "node:fs";

const WORKSHOP = "E:/Steam/steamapps/workshop/content/431960";

function parsePkg(buf) {
  let off = 4 + 8;
  const count = buf.readUInt32LE(off); off += 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const pathLen = buf.readUInt32LE(off); off += 4;
    const p = buf.toString("utf8", off, off + pathLen); off += pathLen;
    const offset = buf.readUInt32LE(off); off += 4;
    const size = buf.readUInt32LE(off); off += 4;
    entries.push({ path: p, offset, size });
  }
  return { entries, dataBase: off };
}

function texHeader(b) {
  if (b.toString("ascii", 0, 4) !== "TEXV") return { err: "not TEXV" };
  let o = 9;
  const texi = b.toString("ascii", o, o + 8); o += 9;
  const format = b.readInt32LE(o); o += 4;
  o += 4; // flags
  const texW = b.readInt32LE(o); o += 4;
  const texH = b.readInt32LE(o); o += 4;
  const imgW = b.readInt32LE(o); o += 4;
  const imgH = b.readInt32LE(o); o += 4;
  o += 4;
  const texb = b.toString("ascii", o, o + 8); o += 9;
  const imageCount = b.readInt32LE(o); o += 4;
  let imageFormat = -1;
  if (texb === "TEXB0003" || texb === "TEXB0004") { imageFormat = b.readInt32LE(o); o += 4; }
  let isVideo = 0;
  if (texb === "TEXB0004") { isVideo = b.readInt32LE(o); o += 4; }
  return { format, texW, texH, imgW, imgH, texb, imageCount, imageFormat, isVideo };
}

for (const id of process.argv.slice(2)) {
  const buf = readFileSync(`${WORKSHOP}/${id}/scene.pkg`);
  const pkg = parsePkg(buf);
  console.log(`=== ${id} ===`);
  for (const e of pkg.entries.filter((x) => x.path.endsWith(".tex") && !x.path.includes("masks/") && !x.path.includes("presets/") && !x.path.includes("particle"))) {
    const h = texHeader(buf.subarray(pkg.dataBase + e.offset, pkg.dataBase + e.offset + Math.min(e.size, 128)));
    console.log(`  ${e.path} ${e.size}B`, JSON.stringify(h));
  }
}
