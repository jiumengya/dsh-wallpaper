// Round-7 UI verification: headless Edge + CDP against the running app backend.
// Usage: node verify-round7.mjs <appUrl> <outPng>
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const outPng = process.argv[3];
const CDP = 9333;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
import { existsSync } from "node:fs";
const EDGE = EDGE_CANDIDATES.find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const profile = mkdtempSync(join(tmpdir(), "dshwp-ver-"));
const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  "--window-size=1600,900",
  "--disable-gpu",
  "--no-first-run",
  url,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const boot = await evalJS(`(() => ({
  on: document.body.classList.contains('dshWp-on'),
  layer: !!document.getElementById('dshWpBg'),
  hasCapCss: [...document.querySelectorAll('style')].some(s => s.textContent.includes('max-width:min(720px')),
  adaptive: [...document.body.classList].filter(c => c.startsWith('dshWp-')),
  title: document.title,
}))()`);

const namedButtons = await evalJS(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 24);
    if (name) out.push(name);
  }
  return out;
})()`);

const clickedSettings = await evalJS(`(() => {
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    if (/^(设置|settings|Settings)/i.test(name)) { el.click(); return name; }
  }
  return '';
})()`);

await sleep(2500);

const dialogProbe = `(() => {
  const dlg = document.querySelector("[role='dialog'][aria-modal='true']");
  if (!dlg) return { exists: false };
  const cs = getComputedStyle(dlg);
  const rect = dlg.getBoundingClientRect();
  const section = dlg.querySelector('.dshWp_section');
  const ink = section ? getComputedStyle(section).color : '';
  return {
    exists: true,
    maxWidth: cs.maxWidth,
    maxHeight: cs.maxHeight,
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    vw: innerWidth,
    vh: innerHeight,
    labelPrimaryVar: cs.getPropertyValue('--dsw-alias-label-primary').trim(),
    sectionPresent: !!section,
    sectionInk: ink,
  };
})()`;
const dialogBefore = await evalJS(dialogProbe);

const clickedSection = await evalJS(`(() => {
  const dlg = document.querySelector("[role='dialog'][aria-modal='true']");
  if (!dlg) return false;
  const leaves = [...dlg.querySelectorAll('button,[role=button],[role=tab]')]
    .filter(el => (el.textContent || '').trim() === '壁纸');
  if (leaves.length) { leaves[0].click(); return true; }
  const any = [...dlg.querySelectorAll('*')]
    .filter(el => (el.textContent || '').trim() === '壁纸' && el.children.length === 0);
  if (any.length) { (any[0].closest('button,[role=button],[role=tab]') || any[0]).click(); return true; }
  return false;
})()`);

await sleep(6000);
const dialogAfter = await evalJS(dialogProbe);

const gridInfo = await evalJS(`(() => {
  const dlg = document.querySelector("[role='dialog'][aria-modal='true']");
  if (!dlg) return {};
  const cards = dlg.querySelectorAll('.dshWp_card').length;
  const status = dlg.querySelector('.dshWp_status');
  return { cards, status: status ? status.textContent.trim() : '' };
})()`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(outPng, Buffer.from(shot.result.data, "base64"));

console.log(JSON.stringify({
  boot,
  namedButtons: namedButtons.slice(0, 60),
  clickedSettings,
  dialogBefore,
  clickedSection,
  dialogAfter,
  gridInfo,
  outPng,
}, null, 2));

ws.close();
try { edge.kill(); } catch { /* already gone */ }
await sleep(800);
process.exit(0);
