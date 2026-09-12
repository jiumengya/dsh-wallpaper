// Re-extract one wallpaper through the real worker; write composite+flat.
// Usage: node reextract-one.mjs <id> [moreIds...]
import { Worker } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WE_ASSETS = "E:/Steam/steamapps/common/wallpaper_engine/assets";
const WORKSHOP = "E:/Steam/steamapps/workshop/content/431960";

for (const id of process.argv.slice(2)) {
  const out = await new Promise((resolve, reject) => {
    const w = new Worker(new URL("../pkg/lib/scene-art-worker.js", import.meta.url));
    w.on("message", (msg) => { void w.terminate(); msg?.error ? reject(new Error(msg.error)) : resolve(msg); });
    w.on("error", reject);
    w.postMessage({ pkgPath: `${WORKSHOP}/${id}/scene.pkg`, weAssetsDir: WE_ASSETS });
  });
  const wrap = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  const comp = wrap(out.data);
  writeFileSync(join(tmpdir(), `${id}-reextract.png`), comp);
  if (out.flat) writeFileSync(join(tmpdir(), `${id}-reextract-flat.png`), wrap(out.flat));
  console.log(id, "composite", comp.length, "flat", !!out.flat, "anim", out.anim ? out.anim.systems.length + " systems" : "null");
}
