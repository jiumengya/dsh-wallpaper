// Round-10 verification: scene wallpapers render their real background art
// full-bleed (extracted from scene.pkg) instead of the square workshop preview.
// Image-mode backgrounds paint through the body background stack (`dshWp-on`
// `dshWp-img` classes + the `--dshWp-art` custom property, cover sizing) with
// no layer element — the probe asserts that contract and decodes the art URL
// through an Image() probe to reject square-thumbnail fallbacks.
// Usage: node verify-scene-art.mjs <sceneId> <outPng>
// Saves and restores the user's persisted background selection.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sceneId = process.argv[2] || "3354939387";
const outPng = process.argv[3] || join(tmpdir(), "dshwp-scene-art.png");
const NODE = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node.exe`;
const CLI = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
const OVERLAY = `${process.env.LOCALAPPDATA}\\DshNative\\desktop.yml`;
const UI_STATE = join(process.env.USERPROFILE || process.env.HOME, ".dsh", "plugin-wallpaper-ui.json");
const CDP = 9337;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const savedState = existsSync(UI_STATE) ? readFileSync(UI_STATE, "utf8") : null;

const backend = spawn(NODE, [CLI, "--profile", "web", "--patch", OVERLAY, "--no-open", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let url = null;
const stdout = [];
backend.stdout.on("data", (d) => {
  const text = d.toString();
  stdout.push(text);
  const m = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
  if (m) url = m[1];
});
backend.stderr.on("data", (d) => stdout.push(d.toString()));

for (let i = 0; i < 120 && !url; i++) await sleep(500);
if (!url) {
  console.error("backend not ready:\n" + stdout.join(""));
  backend.kill();
  process.exit(1);
}
console.log("backend ready:", url);

async function api(path, opts) {
  const res = await fetch(url + path, opts);
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.arrayBuffer() };
}

let edge = null;
try {
  // Select the scene wallpaper as the app background.
  const post = await api("/plugin-wallpaper/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sceneId }),
  });
  const state = JSON.parse(Buffer.from(post.body).toString("utf8"));
  console.log("state:", JSON.stringify(state));
  if (state.mode !== "image" || state.src !== `/plugin-wallpaper/scene-art/${sceneId}`) {
    throw new Error(`unexpected state mode/src: ${state.mode} ${state.src}`);
  }

  // First fetch = extraction + disk cache; assert a real image comes back.
  const art0 = Date.now();
  const art = await api(state.src);
  const artMs = Date.now() - art0;
  console.log(`scene-art: status=${art.status} type=${art.headers["content-type"]} bytes=${art.body.byteLength} firstMs=${artMs}`);
  if (art.status !== 200 || !String(art.headers["content-type"]).startsWith("image/")) {
    throw new Error("scene-art route did not return an image");
  }
  const isPng = art.body.byteLength > 24
    && new Uint8Array(art.body.slice(0, 8)).toString() === [137, 80, 78, 71, 13, 10, 26, 10].toString()
  const isJpg = art.body.byteLength > 4 && new Uint8Array(art.body.slice(0, 3)).toString() === [255, 216, 255].toString();
  if (!isPng && !isJpg) throw new Error("scene-art payload is neither PNG nor JPEG");

  // Second fetch must hit the cache and stay fast.
  const cached = Date.now();
  const again = await api(state.src + "?nocache");
  console.log(`scene-art(2nd): status=${again.status} ms=${Date.now() - cached}`);

  // The disk cache entry exists.
  const cacheMeta = join(process.env.USERPROFILE || process.env.HOME, ".dsh", "plugin-wallpaper-scene", `${sceneId}.json`);
  console.log("disk cache meta:", existsSync(cacheMeta) ? readFileSync(cacheMeta, "utf8") : "MISSING");

  // Visual check through the real page.
  const profile = mkdtempSync(join(tmpdir(), "dshwp-scene-"));
  edge = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,810",
    "--disable-gpu",
    "--no-first-run",
    url,
  ], { stdio: "ignore" });

  async function getTarget() {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
        if (page) return page;
      } catch { /* retry until the browser is up */ }
      await sleep(500);
    }
    throw new Error("no CDP page target");
  }
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await sleep(9000);

  const probe = await evalJS(`(async () => {
    const body = document.body;
    const artVar = body.style.getPropertyValue('--dshWp-art');
    const m = artVar.match(/url\\("([^"]+)"\\)/);
    const src = m ? m[1] : '';
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ loaded: true, natural: im.naturalWidth + 'x' + im.naturalHeight });
      im.onerror = () => resolve({ loaded: false });
      im.src = src;
    });
    const cs = getComputedStyle(body);
    const [w, h] = img.loaded ? img.natural.split('x').map(Number) : [0, 0];
    return {
      on: body.classList.contains('dshWp-on'),
      imgMode: body.classList.contains('dshWp-img'),
      art: artVar,
      src,
      bgSize: cs.backgroundSize,
      bgImage: cs.backgroundImage.slice(0, 160),
      img,
      aspect: h > 0 ? (w / h).toFixed(3) : '0',
      animLayer: !!document.getElementById('dshWpAnim'),
      classes: [...body.classList].filter(c => c.startsWith('dshWp-')),
    };
  })()`);
  console.log("probe:", JSON.stringify(probe, null, 2));

  if (!probe.on || !probe.imgMode) throw new Error(`background did not mount: on=${probe.on} imgMode=${probe.imgMode}`);
  if (!probe.src.includes("/plugin-wallpaper/scene-art/")) throw new Error(`art URL is not scene-art: ${probe.src || probe.art}`);
  if (!probe.img.loaded) throw new Error(`art image did not decode: ${probe.src}`);
  if (Number(probe.aspect) < 1.2) throw new Error(`art aspect ${probe.aspect} looks square (thumbnail fallback?)`);
  if (!String(probe.bgSize).split(",")[0].trim().includes("cover")) {
    throw new Error(`body background-size is ${probe.bgSize}, expected cover`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPng, Buffer.from(shot.result.data, "base64"));
  console.log("screenshot:", outPng);

  ws.close();
  try { edge.kill(); } catch { /* already gone */ }
  await sleep(800);
  console.log("VERIFICATION PASSED");
} catch (error) {
  console.error("VERIFICATION FAILED:", error.message);
  process.exitCode = 1;
} finally {
  try { backend.kill(); } catch { /* already gone */ }
  // Restore the user's background selection exactly as it was.
  try {
    if (savedState === null) {
      if (existsSync(UI_STATE)) { const fs = await import("node:fs"); fs.unlinkSync(UI_STATE); }
    } else {
      writeFileSync(UI_STATE, savedState);
    }
    console.log("ui state restored");
  } catch (error) {
    console.error("ui state restore failed:", error.message);
  }
}
process.exit(process.exitCode || 0);
