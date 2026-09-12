// Probe why a scene's image layers vanish: parse the pkg, walk scene.json
// objects, and report each image layer's model/material/texture resolution.
// Usage: node probe-scene-layers.mjs <workshopId> [moreIds...]
import { readFileSync } from "node:fs";

const WORKSHOP = "E:/Steam/steamapps/workshop/content/431960";

function parsePkg(buf) {
  let off = 4;
  const magic = buf.toString("ascii", off, off + 8); off += 8;
  if (!/^PKGV00\d\d$/.test(magic)) throw new Error(`bad pkg magic ${magic}`);
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

for (const id of process.argv.slice(2)) {
  const buf = readFileSync(`${WORKSHOP}/${id}/scene.pkg`);
  const pkg = parsePkg(buf);
  const read = (e) => buf.subarray(pkg.dataBase + e.offset, pkg.dataBase + e.offset + e.size);
  const find = (p) => pkg.entries.find((e) => e.path === p);
  const readJson = (p) => {
    const e = find(p);
    if (!e) return null;
    try { return JSON.parse(read(e).toString("utf8")); } catch { return null; }
  };
  const scene = readJson("scene.json");
  const objects = scene?.objects ?? [];
  console.log(`\n=== ${id}: ${pkg.entries.length} entries, ${objects.length} objects ===`);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const visOf = (o) => {
    const v = o.visible;
    if (v && typeof v === "object") return v.value !== false;
    return v !== false;
  };
  const norm = (r) => r.replace(/^\/+/, "");
  for (const o of objects) {
    const kind = o.image ? "image" : o.particle ? "particle" : o.text ? "text" : o.model ? "model" : "other";
    let line = `  [${kind}] id=${o.id} name=${JSON.stringify(o.name ?? "").slice(0, 40)} visible=${visOf(o)} parent=${o.parent ?? "-"}`;
    if (o.image) {
      const model = readJson(norm(o.image));
      const matRef = typeof model?.material === "string" ? model.material : "";
      const mat = matRef ? readJson(norm(matRef)) : null;
      const texName = mat?.passes?.[0]?.textures?.[0];
      const cands = texName ? [`materials/${texName}.tex`, `materials/${texName}`, `${texName}.tex`, texName] : [];
      const texEntry = cands.map((c) => find(c)).find(Boolean) ?? null;
      line += ` | model:${model ? "ok" : "MISS(" + o.image + ")"} mat:${mat ? "ok" : "MISS"} tex:${texName ?? "-"} entry:${texEntry ? texEntry.size + "B" : "MISS"}`;
      if (model?.puppet) line += " puppet";
    }
    if (o.particle) line += ` | ${o.particle}`;
    console.log(line);
  }
  // entries of interest
  const texes = pkg.entries.filter((e) => e.path.endsWith(".tex") || e.path.includes("materials/"));
  console.log(`  materials/tex entries: ${texes.length}`);
  for (const t of texes.slice(0, 20)) console.log(`    ${t.path} ${t.size}B`);
}
