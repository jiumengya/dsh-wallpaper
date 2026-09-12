// Round-10 verification: image-mode wallpaper is the page's opaque ROOT
// background — body background stacking (scene art over square preview over a
// solid fallback), no #dshWpBg layer element. A transparent root makes
// Chromium drop subpixel text antialiasing document-wide, which read as
// "wallpaper text looks blurry"; an opaque body background restores it.
// Usage: node verify-fill.mjs <outPng>
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outPng = process.argv[2] || join(tmpdir(), "dshwp-fill.png");
const NODE = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node.exe`;
const CLI = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
const OVERLAY = `${process.env.LOCALAPPDATA}\\DshNative\\desktop.yml`;
const CDP = 9334;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

try {
  const profile = mkdtempSync(join(tmpdir(), "dshwp-fill-"));
  const edge = spawn(EDGE, [
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

  const probe = await evalJS(`(() => {
    const body = document.body;
    const out = {
      layer: !!document.getElementById('dshWpBg'),
      on: body.classList.contains('dshWp-on'),
      img: body.classList.contains('dshWp-img'),
      adaptive: [...body.classList].filter(c => c.startsWith('dshWp-')),
    };
    if (out.img) {
      const cs = getComputedStyle(body);
      out.bodyBg = {
        image: cs.backgroundImage,
        size: cs.backgroundSize,
        position: cs.backgroundPosition,
        repeat: cs.backgroundRepeat,
        color: cs.backgroundColor,
      };
      out.vars = {
        art: body.style.getPropertyValue('--dshWp-art').trim(),
        poster: body.style.getPropertyValue('--dshWp-poster').trim(),
      };
      out.vw = innerWidth; out.vh = innerHeight;
    }
    return out;
  })()`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPng, Buffer.from(shot.result.data, "base64"));

  console.log(JSON.stringify({ probe, outPng }, null, 2));

  ws.close();
  try { edge.kill(); } catch { /* already gone */ }
  await sleep(800);
} finally {
  backend.kill();
}
process.exit(0);
