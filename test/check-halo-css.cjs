// One-shot check for the halo styleText rules: brace/paren balance and the
// presence of every halo declaration. Not part of the verification suite.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "pkg", "lib", "client.js");
const t = fs.readFileSync(file, "utf8");
const m = t.match(/const styleText = \[([\s\S]*?)\];/);
if (!m) throw new Error("styleText not found");
const strs = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
const css = strs.join("");
let bal = 0, par = 0;
for (const c of css) {
  if (c === "{") bal++;
  if (c === "}") bal--;
  if (c === "(") par++;
  if (c === ")") par--;
}
console.log("rules:", strs.length, "brace balance:", bal, "paren balance:", par);
const probes = [
  "--dshWp-halo:transparent",
  "--dshWp-halo:rgba(255,255,255,.55)",
  "--dshWp-halo:rgba(0,0,0,.5)",
  "text-shadow:none",
  "text-shadow:0 0 1px var(--dshWp-halo),0 0 2px var(--dshWp-halo)",
  "filter:drop-shadow(0 0 1px var(--dshWp-halo))",
  "body.dshWp-on.dshWp-side-dark:not([data-ds-dark-theme]) [class*='sidebarCol'],body.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero']{--dshWp-halo:rgba(0,0,0,.5);text-shadow:0 0 1px var(--dshWp-halo),0 0 2px var(--dshWp-halo)",
  "body.dshWp-on.dshWp-side-bright[data-ds-dark-theme] [class*='sidebarCol'],body.dshWp-on.dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero']{--dshWp-halo:rgba(255,255,255,.55);text-shadow:0 0 1px var(--dshWp-halo),0 0 2px var(--dshWp-halo)",
  "[class*='sidebarCol'] [class*='_newSession']{text-shadow:none}",
  "[role='dialog'][aria-modal='true']{text-shadow:none}",
  // Hero input card restates the theme ink so the region flip cannot cascade
  // into its own glass (white-on-white in light theme, dark-on-dark in dark).
  "dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero'] [class*='_card']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000)",
  "dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero'] [class*='_card']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50)",
  "[class*='_composerHero'] [class*='_card']{text-shadow:none}",
  "[class*='_composerHero'] [class*='_card'] svg{filter:none}",
  // Preview badge: pill follows the wallpaper tone, solid fill never haloed.
  "[class*='_composerHero'] [class*='_previewBadge']{text-shadow:none}",
  "dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero'] [class*='_previewBadge']{--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50)",
  "dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero'] [class*='_previewBadge']{--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900)",
];
let fail = 0;
for (const p of probes) {
  const ok = css.includes(p);
  if (!ok) fail++;
  console.log(ok ? "OK  " : "MISS", p);
}
if (bal !== 0 || par !== 0 || fail > 0) process.exit(1);
console.log("ALL CHECKS PASSED");
