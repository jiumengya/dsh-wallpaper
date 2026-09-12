// Round-13 verification: the hero input card keeps theme ink under the region
// flip. Light theme + dark wallpaper used to paint the card's placeholder and
// controls white-on-white (CSS variable inheritance cascades the flip INTO the
// card's own glass); the restate rules must cut that. Also covers the dark
// theme + bright wallpaper symmetric case. Usage: node verify-ink-flip.mjs
// Reuses the user's persisted wallpaper selection (no state changes).
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outA = process.argv[2] || join(tmpdir(), "dshwp-ink-light-dark.png");
const outB = process.argv[3] || join(tmpdir(), "dshwp-ink-dark-bright.png");
const NODE = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node.exe`;
const CLI = `${process.env.LOCALAPPDATA}\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
const OVERLAY = `${process.env.LOCALAPPDATA}\\DshNative\\desktop.yml`;
const CDP = 9337;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Light-theme primary ink (bluish-1000) and dark-theme primary ink (bluish-50).
// getPropertyValue serializes custom properties as hex, .color as rgb() —
// normalize both before comparing.
const hexToRgb = (v) => {
  const m = v.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return v.trim();
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
};
const norm = (v) => (typeof v === "string" ? hexToRgb(v) : v);
const DARK_INK = "rgb(15, 17, 21)";
const LIGHT_INK = "rgb(249, 250, 251)";

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

let edge = null;
let exitCode = 0;
try {
  const profile = mkdtempSync(join(tmpdir(), "dshwp-ink-"));
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

  // The background must be mounted before any ink verdict is meaningful.
  // Image wallpapers mount as the body's own background (dshWp-img class,
  // no layer element); video/web wallpapers mount the #dshWpBg layer.
  const mounted = await evalJS(`(() => {
    const body = document.body;
    return { mounted: !!document.getElementById('dshWpBg') || body.classList.contains('dshWp-img'),
             on: body.classList.contains('dshWp-on'),
             adaptive: [...body.classList].filter(c => c.startsWith('dshWp-')) };
  })()`);
  console.log("background:", JSON.stringify(mounted));
  if (!mounted.mounted || !mounted.on) throw new Error("background did not mount");

  // Force a flip state and read the resolved ink immediately (synchronous reads
  // win against the 2s sampling timer).
  const probe = (dark, region) => evalJS(`(() => {
    try {
    const dark = ${JSON.stringify(dark)}, region = ${JSON.stringify(region)};
    const body = document.body;
    for (const c of ['dshWp-side-dark','dshWp-side-bright','dshWp-main-dark','dshWp-main-bright']) body.classList.remove(c);
    if (dark) body.setAttribute('data-ds-dark-theme', ''); else body.removeAttribute('data-ds-dark-theme');
    body.classList.add('dshWp-on', 'dshWp-' + region);
    const hero = document.querySelector("[class*='_composerHero']");
    const card = document.querySelector("[class*='_composerHero'] [class*='_card']");
    const headline = document.querySelector("[class*='_composerHero'] [class*='headlineText']");
    const badge = document.querySelector("[class*='_composerHero'] [class*='_previewBadge']");
    const side = document.querySelector("[class*='sidebarCol']");
    const ta = card && card.querySelector('textarea');
    const out = { region, dark };
    out.sidebarTextShadow = side ? getComputedStyle(side).textShadow : 'ABSENT';
    const tok = (el, name) => el ? getComputedStyle(el).getPropertyValue(name).trim() : 'ABSENT';
    out.heroPrimary = tok(hero, '--dsw-alias-label-primary');
    out.cardPrimary = tok(card, '--dsw-alias-label-primary');
    out.cardTertiary = tok(card, '--dsw-alias-label-tertiary');
    out.headlineColor = headline ? getComputedStyle(headline).color : 'ABSENT';
    out.sidePrimary = tok(side, '--dsw-alias-label-primary');
    if (ta) {
      out.taColor = getComputedStyle(ta).color;
      out.taPlaceholder = getComputedStyle(ta, '::placeholder').color;
    }
    if (badge) {
      const bcs = getComputedStyle(badge);
      out.badge = {
        fill: bcs.backgroundColor,
        ink: bcs.color,
        textShadow: bcs.textShadow,
        border: bcs.borderColor,
      };
    }
    out.heroExists = !!hero; out.cardExists = !!card; out.badgeExists = !!badge;
    return out;
    } catch (e) { return { err: String(e && e.message || e) }; }
  })()`);

  // Scenario A: light theme, dark main area (the reported bug).
  const a = await probe(false, "main-dark");
  console.log("A light+main-dark:", JSON.stringify(a, null, 2));
  const shotA = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outA, Buffer.from(shotA.result.data, "base64"));

  // Scenario B: dark theme, bright main area (the symmetric case).
  const b = await probe(true, "main-bright");
  console.log("B dark+main-bright:", JSON.stringify(b, null, 2));
  const shotB = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outB, Buffer.from(shotB.result.data, "base64"));

  console.log("screenshots:", outA, outB);

  const fail = [];
  if (!a.heroExists) fail.push("A: hero stack missing (not a blank session?)");
  if (!a.cardExists) fail.push("A: input card missing");
  // Flipped hero ink (light ink on dark wallpaper)...
  if (norm(a.heroPrimary) !== LIGHT_INK) fail.push(`A: hero ink ${a.heroPrimary} !== ${LIGHT_INK}`);
  // ...but the card restates the LIGHT-THEME dark ink on its own glass.
  if (norm(a.cardPrimary) !== DARK_INK) fail.push(`A: card ink ${a.cardPrimary} !== ${DARK_INK} (placeholder/typed text would be white-on-white)`);
  if (norm(a.headlineColor) !== LIGHT_INK) fail.push(`A: headline ${a.headlineColor} !== ${LIGHT_INK}`);
  if (a.sidebarTextShadow === 'none') fail.push('A: dark sidebar has no contrast ring');
  if (a.taPlaceholder && a.taPlaceholder === "rgba(0, 0, 0, 0)") fail.push("A: placeholder fully transparent?");
  if (!b.heroExists) fail.push("B: hero stack missing");
  if (!b.cardExists) fail.push("B: input card missing");
  if (norm(b.heroPrimary) !== DARK_INK) fail.push(`B: hero ink ${b.heroPrimary} !== ${DARK_INK}`);
  if (norm(b.cardPrimary) !== LIGHT_INK) fail.push(`B: card ink ${b.cardPrimary} !== ${LIGHT_INK} (dark-on-dark)`);
  if (norm(b.headlineColor) !== DARK_INK) fail.push(`B: headline ${b.headlineColor} !== ${DARK_INK}`);
  if (b.sidebarTextShadow === 'none') fail.push('B: bright sidebar has no contrast ring');
  // Badge pill follows the WALLPAPER tone: dark wallpaper -> dark-theme pill
  // (deepseek-800 fill, light ink), bright wallpaper -> light-theme pill
  // (deepseek-100 fill, blue-900 ink). Solid fill never carries the halo.
  const DARK_FILL = "rgb(52, 65, 91)";
  const LIGHT_FILL = "rgb(228, 237, 253)";
  const BLUE_INK = "rgb(14, 48, 116)";
  if (!a.badgeExists) fail.push("A: preview badge missing");
  else {
    if (a.badge.fill !== DARK_FILL) fail.push(`A: badge fill ${a.badge.fill} !== ${DARK_FILL} (pale pill on dark wallpaper)`);
    if (norm(a.badge.ink) !== LIGHT_INK) fail.push(`A: badge ink ${a.badge.ink} !== ${LIGHT_INK}`);
    if (a.badge.textShadow !== "none") fail.push(`A: badge halo leaked: ${a.badge.textShadow}`);
  }
  if (!b.badgeExists) fail.push("B: preview badge missing");
  else {
    if (b.badge.fill !== LIGHT_FILL) fail.push(`B: badge fill ${b.badge.fill} !== ${LIGHT_FILL} (dark pill on bright wallpaper)`);
    if (norm(b.badge.ink) !== BLUE_INK) fail.push(`B: badge ink ${b.badge.ink} !== ${BLUE_INK}`);
    if (b.badge.textShadow !== "none") fail.push(`B: badge halo leaked: ${b.badge.textShadow}`);
  }

  if (fail.length) {
    console.error("FAILURES:\n" + fail.map((f) => "  - " + f).join("\n"));
    exitCode = 1;
  } else {
    console.log("ALL INK CHECKS PASSED");
  }

  // Leave the body as we found it.
  await evalJS(`(() => {
    const body = document.body;
    for (const c of ['dshWp-side-dark','dshWp-side-bright','dshWp-main-dark','dshWp-main-bright']) body.classList.remove(c);
    return true;
  })()`);

  ws.close();
  try { edge.kill(); } catch { /* already gone */ }
} catch (error) {
  console.error("VERIFICATION FAILED:", error.message);
  exitCode = 1;
  try { if (edge) edge.kill(); } catch { /* already gone */ }
} finally {
  try { backend.kill(); } catch { /* already gone */ }
}
await sleep(800);
process.exit(exitCode);
