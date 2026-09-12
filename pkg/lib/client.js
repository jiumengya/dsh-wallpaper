/**
 * Browser half of the Wallpaper Engine plugin. Two responsibilities:
 * 1. On boot, mount the persisted whole-page background — a fixed layer under
 *    the app content. While active the plugin transparentizes the app base,
 *    the sidebar fill and the composer tint so the wallpaper shows through
 *    everywhere, and floats modal dialogs (settings, Modal primitive) on the
 *    live wallpaper as liquid glass — without any backdrop-filter, which
 *    freezes the underlying video/iframe animation; content panels keep
 *    their own backgrounds for legibility. Dialog ink always follows the
 *    theme (black on light / white on dark) regardless of the wallpaper, and
 *    the dialog is capped so the wallpaper stays visible around it.
 *    Wallpaper luminance is sampled per region (sidebar strip vs main area,
 *    median so a local bright/dark patch cannot skew the verdict) and the
 *    label ink of the regions that sit directly on the wallpaper flips
 *    toward readable contrast when it clashes with the active theme; the
 *    composer glass densifies instead. One ink per region cannot beat every
 *    local patch of the opposite tone, so the on-wallpaper ink also carries
 *    a tight opposite-tone ring hugging the glyph outline (text-shadow +
 *    svg drop-shadow, no offset, no wide blur) — invisible where the ink
 *    already contrasts with the wallpaper, visible exactly where it
 *    clashes. Widgets with their own opaque/theme-tinted surfaces
 *    never flip: the new-session button, modal dialogs and the hero input
 *    card restate the theme ink so their contents match their own fill.
 *    Render modes: video wallpapers play their original file, web wallpapers
 *    load in an iframe (their animations and particle effects run natively),
 *    and scene/image wallpapers paint their real art (the scene background
 *    extracted host-side from scene.pkg) as the page's OPAQUE root background
 *    — not a transparent app over a fixed layer: a transparent root makes
 *    Chromium drop subpixel text antialiasing document-wide, and the
 *    grayscale glyphs read as "wallpaper text looks blurry". The square
 *    workshop preview rides as the second background layer, bridging the
 *    first scene extraction and remaining as the error fallback. Video and
 *    web wallpapers cannot be CSS backgrounds, so they keep the fixed layer
 *    — text over animated content stays grayscale there (Chromium
 *    constraint, same as text over any video on the web).
 * 2. The "壁纸" settings section: pick a Wallpaper Engine wallpaper as the
 *    whole-page DeepSeek Harness background.
 * Plain JavaScript (no JSX/TS) — elements are built with React.createElement,
 * styling rides the official dsw CSS variables.
 * @module @deepseek-ai/dsh-wallpaper/client
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-wallpaper",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = React.createElement;

    // ── styles (official dsw aliases so light/dark themes both apply) ──────

    const css = {
      section: "dshWp_section",
      toolbar: "dshWp_toolbar",
      status: "dshWp_status",
      btn: "dshWp_btn",
      btnIcon: "dshWp_btnIcon",
      search: "dshWp_search",
      grid: "dshWp_grid",
      card: "dshWp_card",
      thumbWrap: "dshWp_thumbWrap",
      thumb: "dshWp_thumb",
      thumbFallback: "dshWp_thumbFallback",
      deskBtn: "dshWp_deskBtn",
      cardBody: "dshWp_cardBody",
      cardTitle: "dshWp_cardTitle",
      cardMeta: "dshWp_cardMeta",
      type: "dshWp_type",
      current: "dshWp_current",
      notice: "dshWp_notice",
      hint: "dshWp_hint",
      retry: "dshWp_retry",
    };

    const styleText = [
      // Whole-page background: transparentize every large opaque surface so the
      // fixed layer shows through — the app base, the sidebar fill and the
      // composer card (the latter keeps a translucent tint for legibility).
      // Content panels (bg-layer-*) keep their own backgrounds on purpose.
      "body.dshWp-on.dshWp-on{--dsw-alias-bg-base:transparent;--dsw-specific-sidebar-fill:transparent;--dsw-specific-input-major:color-mix(in srgb,#fff 62%,transparent)}",
      "body[data-ds-dark-theme].dshWp-on.dshWp-on{--dsw-specific-input-major:color-mix(in srgb,rgb(21,21,23) 62%,transparent)}",
      "#dshWpBg{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}",
      "#dshWpBg video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}",
      "#dshWpBg iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}",
      // Scene particle animation: a transparent fixed canvas above the body's
      // opaque root background and below the app content. The root background
      // stays opaque, so subpixel text antialiasing survives the overlay.
      "#dshWpAnim{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}",
      "#dshWpAnim canvas{position:absolute;inset:0;width:100%;height:100%;display:block}",
      // Image mode paints the wallpaper as the page's opaque ROOT background
      // (body background, cover) instead of a transparent app over a fixed
      // layer: a transparent root makes Chromium drop subpixel text
      // antialiasing document-wide — the grayscale glyphs were the "wallpaper
      // text looks blurry" symptom. The real art stacks over the poster
      // (bridge while a first scene extraction runs, error fallback when the
      // art is unusable), and an opaque fallback color sits beneath both.
      // Video and web wallpapers cannot be CSS backgrounds and keep the
      // fixed layer — text over them stays grayscale (Chromium constraint).
      "body.dshWp-on.dshWp-on.dshWp-img{background:var(--dshWp-art) center/cover no-repeat,var(--dshWp-poster,none) center/cover no-repeat var(--dshWp-bg-fallback,#fff)}",
      "body[data-ds-dark-theme].dshWp-on.dshWp-on.dshWp-img{--dshWp-bg-fallback:#151517}",
      // Modal dialogs (settings, Modal primitive) float on the live wallpaper
      // as liquid glass. NO backdrop-filter anywhere: Chromium freezes the
      // underlying video/iframe animation frames while a backdrop-filter
      // element covers them (observed with web wallpapers), and the official
      // mask already carries blur(2px) — it must be neutralized too, or the
      // wallpaper stops the moment the dialog opens. The glass look is painted
      // statically instead: a translucent fill, a diagonal specular gradient,
      // a 1px highlight rim and an inner glow.
      "body.dshWp-on.dshWp-on [aria-hidden='true']:has(+ [role='dialog'][aria-modal='true']){background:color-mix(in srgb,var(--dsw-alias-bg-mask-1) 35%,transparent);backdrop-filter:none}",
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true']{background:transparent}",
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true']::before{content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;background:linear-gradient(160deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.14) 30%,rgba(255,255,255,0) 55%),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),inset 0 0 0 1px rgba(255,255,255,.26),inset 0 -16px 32px rgba(255,255,255,.08),0 24px 48px rgba(0,0,0,.18)}",
      "body[data-ds-dark-theme].dshWp-on.dshWp-on [role='dialog'][aria-modal='true']::before{background:linear-gradient(160deg,rgba(255,255,255,.09) 0%,rgba(255,255,255,.03) 30%,rgba(255,255,255,0) 55%),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 85%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.09),0 24px 48px rgba(0,0,0,.46)}",
      // Dialog ink always follows the theme, never the wallpaper flip. The
      // official Modal renders in place (no portal), so a dialog opened from
      // the sidebar is a descendant of the sidebar column and would inherit
      // its flipped label tokens — near-white ink on the white glass. Restating
      // the theme defaults on the dialog cuts that inheritance; the input
      // major fill returns to the official solid token too.
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-00)}",
      "body[data-ds-dark-theme].dshWp-on.dshWp-on [role='dialog'][aria-modal='true']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850)}",
      // While a wallpaper is on, cap the dialog so more of it stays visible
      // around the glass (the stock panel fills ~89% of the viewport height
      // and hides the wallpaper behind a "head" only). Content scrolls.
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true']{max-width:min(720px,92vw);max-height:74vh}",
      // Adaptive ink (liquid-glass legibility): the client samples the sidebar
      // strip and the main area of the wallpaper separately and toggles
      // dshWp-side/main-dark/bright. A dark region under the light theme flips
      // the region's label tokens to the dark-theme palette (near-white ink);
      // a bright region under the dark theme flips back to the light-theme
      // palette. Mid-tones keep the theme defaults. Scoped to the two regions
      // that sit directly on the wallpaper — the sidebar column and the hero
      // stack (blank-session headline + workspace chip); message cards and the
      // composer glass keep their own backgrounds, so the composer instead
      // just gets a denser glass fill on clashing wallpapers.
      "body.dshWp-on.dshWp-side-dark:not([data-ds-dark-theme]) [class*='sidebarCol'],body.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800)}",
      "body.dshWp-on.dshWp-side-bright[data-ds-dark-theme] [class*='sidebarCol'],body.dshWp-on.dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00)}",
      // The new-session button keeps its own opaque elevated fill — its ink
      // stays the theme default instead of following the sidebar flip.
      "body.dshWp-on.dshWp-side-dark:not([data-ds-dark-theme]) [class*='sidebarCol'] [class*='_newSession']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000)}",
      "body.dshWp-on.dshWp-side-bright[data-ds-dark-theme] [class*='sidebarCol'] [class*='_newSession']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50)}",
      "body.dshWp-on.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]){--dsw-specific-input-major:color-mix(in srgb,#fff 86%,transparent)}",
      "body.dshWp-on.dshWp-on.dshWp-main-bright[data-ds-dark-theme]{--dsw-specific-input-major:color-mix(in srgb,rgb(21,21,23) 86%,transparent)}",
      // The hero input card keeps its theme-tinted glass (white in the light
      // theme, near-black in the dark theme) — it never sits bare on the
      // wallpaper. The region flip above exists for the headline and the
      // workspace chip that DO sit on the wallpaper, but CSS variables
      // inherit down the DOM: without a restate the flipped ink cascades
      // INTO the card and paints placeholder/typed text and controls
      // white-on-white (light theme, dark wallpaper) or dark-on-dark (dark
      // theme, bright wallpaper). Restating the theme ink on the card cuts
      // the inheritance — same pattern as the dialog fix.
      "body.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero'] [class*='_card']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00)}",
      "body.dshWp-on.dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero'] [class*='_card']{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800)}",
      // Card contents ride their own glass — no wallpaper halo either.
      "body.dshWp-on.dshWp-on [class*='_composerHero'] [class*='_card']{text-shadow:none}",
      "body.dshWp-on.dshWp-on [class*='_composerHero'] [class*='_card'] svg{filter:none}",
      // The preview badge carries its own tinted pill (business-tertiary
      // fill + bluish ink + hover border), so unlike the headline it never
      // sits bare on the wallpaper — and its pill is THEME-tinted, which
      // clashes when the theme and the wallpaper disagree: light theme +
      // dark wallpaper showed the official light pill (pale blue fill,
      // dark ink) AND inherited the on-wallpaper halo, reading as a pale
      // chip with glowing black text. The pill follows the WALLPAPER tone
      // instead: dark wallpaper -> the dark-theme pill (deep fill, light
      // ink), bright wallpaper -> the light-theme pill — the badge keeps
      // contrast against whatever is actually behind it. Solid fill also
      // means no halo: text-shadow:none always.
      "body.dshWp-on.dshWp-on [class*='_composerHero'] [class*='_previewBadge']{text-shadow:none}",
      "body.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero'] [class*='_previewBadge']{--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08)}",
      "body.dshWp-on.dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero'] [class*='_previewBadge']{--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900);--dsw-alias-interactive-bg-hover:rgba(38,49,72,.06)}",
      // Local-contrast ring (completes the adaptive ink): the region flip
      // picks ONE ink from the dominant tone, but wallpapers carry local
      // patches of the opposite tone (a window, a glow, a bright sky) that
      // can sit right under the glyphs. A tight opposite-tone ring hugs the
      // glyph outline instead of a halo: an offset shadow plus a wide blur
      // (the earlier 0 1px 2px + 0 0 7px halo) read as glowing, smeared
      // edges on mid-tone wallpapers. The 1px+2px ring stays invisible
      // where the ink already contrasts with the wallpaper and outlines
      // the glyph exactly where it clashes — per-glyph only, no overlay,
      // the wallpaper stays fully visible and animated.
      // Do not paint a global halo: on a light/mid wallpaper that turns the
      // official black ink into black text with an obvious white outline.
      // Only add an opposite-tone ring in the two actual contrast-flip
      // states below (white ink on dark wallpaper, black ink on bright
      // wallpaper). Normal black text stays clean and sharp.
      "body.dshWp-on.dshWp-on [class*='sidebarCol'],body.dshWp-on.dshWp-on [class*='_composerHero']{--dshWp-halo:transparent;text-shadow:none}",
      "body.dshWp-on.dshWp-side-dark:not([data-ds-dark-theme]) [class*='sidebarCol'],body.dshWp-on.dshWp-main-dark:not([data-ds-dark-theme]) [class*='_composerHero']{--dshWp-halo:rgba(0,0,0,.5);text-shadow:0 0 1px var(--dshWp-halo),0 0 2px var(--dshWp-halo)}",
      "body.dshWp-on.dshWp-side-bright[data-ds-dark-theme] [class*='sidebarCol'],body.dshWp-on.dshWp-main-bright[data-ds-dark-theme] [class*='_composerHero']{--dshWp-halo:rgba(255,255,255,.55);text-shadow:0 0 1px var(--dshWp-halo),0 0 2px var(--dshWp-halo)}",
      "body.dshWp-on.dshWp-on [class*='sidebarCol'] svg,body.dshWp-on.dshWp-on [class*='_composerHero'] svg{filter:drop-shadow(0 0 1px var(--dshWp-halo))}",
      // Opaque widgets keep their own contrast — the new-session button
      // paints its elevated fill with theme ink, and modal dialogs restate
      // their ink on the glass — neither wants the wallpaper halo.
      "body.dshWp-on.dshWp-on [class*='sidebarCol'] [class*='_newSession']{text-shadow:none}",
      "body.dshWp-on.dshWp-on [class*='sidebarCol'] [class*='_newSession'] svg{filter:none}",
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true']{text-shadow:none}",
      "body.dshWp-on.dshWp-on [role='dialog'][aria-modal='true'] svg{filter:none}",
      // Settings section.
      ".dshWp_section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}",
      ".dshWp_toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshWp_status{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshWp_status b{color:var(--dsw-alias-label-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshWp_btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;border-radius:6px;padding:4px 10px;cursor:pointer}",
      ".dshWp_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshWp_btn:disabled{opacity:.45;cursor:default}",
      ".dshWp_btn:disabled:hover{background:0 0}",
      ".dshWp_btnIcon{display:inline-flex;align-items:center;gap:5px}",
      ".dshWp_search{width:100%;display:flex;position:relative;color:var(--dsw-alias-label-tertiary)}",
      ".dshWp_search>svg{pointer-events:none;position:absolute;left:12px;top:10px}",
      ".dshWp_search input{width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;border-radius:8px;outline:0;padding:0 12px 0 36px}",
      ".dshWp_search input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dshWp_search input:focus-visible{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}",
      ".dshWp_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;align-items:start}",
      ".dshWp_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;overflow:hidden;cursor:pointer;text-align:left;padding:0;font:inherit;min-width:0}",
      ".dshWp_card:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshWp_card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dshWp_card[data-current=true]{border-color:var(--dsw-alias-brand-primary)}",
      ".dshWp_card[data-busy=true]{opacity:.6;cursor:default}",
      ".dshWp_thumbWrap{width:100%;aspect-ratio:16/9;background:var(--dsw-alias-bg-layer-1);overflow:hidden;position:relative}",
      ".dshWp_thumb{width:100%;height:100%;object-fit:cover;display:block}",
      ".dshWp_thumbFallback{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".dshWp_deskBtn{position:absolute;top:8px;right:8px;border:1px solid rgba(255,255,255,.28);background:rgba(0,0,0,.5);color:#fff;font:inherit;font-size:11px;line-height:16px;border-radius:6px;padding:2px 8px;cursor:pointer;opacity:0;transition:opacity 120ms ease}",
      ".dshWp_card:hover .dshWp_deskBtn,.dshWp_card:focus-within .dshWp_deskBtn,.dshWp_deskBtn[data-busy=true]{opacity:1}",
      ".dshWp_deskBtn:hover{background:rgba(0,0,0,.68)}",
      ".dshWp_deskBtn:disabled{cursor:default;opacity:.6}",
      ".dshWp_cardBody{box-sizing:border-box;padding:8px 10px 9px;display:flex;flex-direction:column;gap:3px}",
      ".dshWp_cardTitle{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshWp_cardMeta{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dshWp_type{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".dshWp_current{color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px;font-weight:600;flex:none}",
      ".dshWp_notice{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin:0}",
      ".dshWp_hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
      ".dshWp_retry{margin:0}",
    ].join("");

    const cssTagId = "@deepseek-ai/dsh-wallpaper/section.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-wallpaper";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = styleText;
      document.head.appendChild(tag);
    }

    // ── data access ────────────────────────────────────────────────────────

    async function apiGet(path) {
      const res = await fetch(path);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    async function apiPost(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    function pickWallpaperFile() {
      return new Promise((resolve, reject) => {
        if (!window.chrome?.webview) {
          reject(new Error("当前运行环境不支持选择本地文件"));
          return;
        }
        const onMessage = (event) => {
          const value = event.data;
          if (!value || value.source !== "dsh-native" || value.type !== "wallpaper-file-picked") return;
          window.chrome.webview.removeEventListener("message", onMessage);
          resolve(typeof value.path === "string" ? value.path : null);
        };
        window.chrome.webview.addEventListener("message", onMessage);
        window.chrome.webview.postMessage({ source: "dsh-native", type: "pick-wallpaper-file" });
      });
    }

    const TYPE_LABELS = { scene: "场景·大图", video: "视频·动效", web: "网页·完整动效", application: "应用·完整动效" };
    const typeLabel = (type) => TYPE_LABELS[type] || "未知";

    // ── app background layer (boot + settings section share these) ─────────

    const BG_LAYER_ID = "dshWpBg";
    const BG_ON_CLASS = "dshWp-on";
    const BG_IMG_CLASS = "dshWp-img";

    // ── adaptive ink: sample wallpaper luminance, flip label colors locally ──
    // The sidebar strip (left ~22%) and the main area are measured separately;
    // each region flips toward readable ink only when its own wallpaper region
    // clashes with the active theme (dark strip under light theme → light ink,
    // bright strip under dark theme → dark ink). Neutral mid-tones keep the
    // theme defaults.

    const ADAPT = {
      canvas: null,
      ctx: null,
      timer: 0,
      img: null,
    };

    /** Luminance thresholds: below DARK / above BRIGHT flips the region ink. */
    const LUM_DARK = 0.38;
    const LUM_BRIGHT = 0.62;
    /** Sampling canvas size — small enough to be cheap every tick. */
    const SAMPLE_W = 64;
    const SAMPLE_H = 36;

    /**
     * Draw the current background source into the sampling canvas and update
     * the adaptive body classes. `source` is the mounted `<video>` element or
     * a same-origin poster/preview `Image`; both render cover-scaled, so the
     * sample is a plain stretch of the source.
     * @param {HTMLVideoElement|HTMLImageElement} source Drawable background source.
     */
    function sampleAdaptive(source) {
      try {
        if (!ADAPT.canvas) {
          ADAPT.canvas = document.createElement("canvas");
          ADAPT.canvas.width = SAMPLE_W;
          ADAPT.canvas.height = SAMPLE_H;
          ADAPT.ctx = ADAPT.canvas.getContext("2d", { willReadFrequently: true });
        }
        ADAPT.ctx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
        const { data } = ADAPT.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        const sideMaxX = Math.floor(SAMPLE_W * 0.22);
        const sideLums = [], mainLums = [];
        for (let y = 0; y < SAMPLE_H; y++) {
          for (let x = 0; x < SAMPLE_W; x++) {
            const i = (y * SAMPLE_W + x) * 4;
            const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            if (x < sideMaxX) { sideLums.push(lum) } else { mainLums.push(lum) }
          }
        }
        // Median, not mean: a mostly-dark wallpaper with one bright patch
        // (moon, window, glow) must still read as dark — the mean gets
        // dragged past the threshold and keeps ink that clashes with the
        // dominant tone; the halo covers the local patch instead.
        const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1] };
        const side = median(sideLums);
        const main = median(mainLums);
        document.body.classList.toggle("dshWp-side-dark", side < LUM_DARK);
        document.body.classList.toggle("dshWp-side-bright", side > LUM_BRIGHT);
        document.body.classList.toggle("dshWp-main-dark", main < LUM_DARK);
        document.body.classList.toggle("dshWp-main-bright", main > LUM_BRIGHT);
      } catch {
        // Sampling is best-effort (e.g. cross-origin source taints the canvas).
      }
    }

    /**
     * Start adaptive sampling for the mounted background: videos are resampled
     * on a timer (brightness shifts as they play), images and iframe posters
     * once on load.
     * @param {object} state - resolved background state (mode/src/poster).
     */
    function startAdaptive(state) {
      stopAdaptive();
      if (state.mode === "video") {
        const video = document.querySelector(`#${BG_LAYER_ID} video`);
        if (video) {
          const tick = () => { if (video.readyState >= 2) sampleAdaptive(video) };
          video.addEventListener("loadeddata", tick, { once: true });
          tick();
          ADAPT.timer = setInterval(tick, 2000);
        }
      } else {
        const src = state.mode === "image" ? state.src : state.poster;
        if (!src) return;
        const img = new Image();
        img.onload = () => sampleAdaptive(img);
        img.src = src;
        ADAPT.img = img;
      }
    }

    /** Stop sampling and drop the adaptive classes (background removed). */
    function stopAdaptive() {
      if (ADAPT.timer) { clearInterval(ADAPT.timer); ADAPT.timer = 0 }
      ADAPT.img = null;
      if (typeof document !== "undefined" && document.body) {
        for (const cls of ["dshWp-side-dark", "dshWp-side-bright", "dshWp-main-dark", "dshWp-main-bright"]) {
          document.body.classList.remove(cls);
        }
      }
    }

    /** Drop the image-mode body marks (class + background CSS variables). */
    function unmarkImageBackground(body) {
      body.classList.remove(BG_IMG_CLASS);
      body.style.removeProperty("--dshWp-art");
      body.style.removeProperty("--dshWp-poster");
    }

    // ── scene particle animation (live canvas overlay) ─────────────────────
    // Scene wallpapers with particle systems export their definitions
    // host-side (`/plugin-wallpaper/scene-anim/<id>` JSON plus texture
    // atlases); the client replays them here — the same formulas scene-art.js
    // samples for its static steady-state frame, driven by a clock instead of
    // a random phase. MP4 video layers export the same way
    // (`/plugin-wallpaper/scene-video/<id>`): WE stores chroma-keyed video
    // layers as TEX-wrapped H.264, the host exports their bytes plus matrix
    // and colorkey, and the client plays each layer through a detached
    // <video> and an offscreen WebGL keyer ported from WE's colorkey.frag.
    // Either export alone mounts the canvas. It paints the FLAT art itself
    // every frame, the keyed videos and the particles on top of it: additive
    // sprites rely on `lighter` adding into the real scene pixels (a
    // transparent overlay would composite element-wise over the page, turning
    // additive black backgrounds into opaque dark squares). The canvas rides
    // above the body's opaque root background (same flat art, same cover
    // math, so the swap is invisible) and below the app content. When neither
    // export — or the art the canvas needs as its base — is available, the
    // art falls back to the composite with the baked particles and no canvas
    // mounts. Rotation follows the reference operator semantics
    // (angularmovement integrates the initializer's angular velocity) rather
    // than the static sampler's approximation.

    const ANIM_LAYER_ID = "dshWpAnim";
    /** Supersample factor for tinted sprite variants (sprites upscale ~2x). */
    const ANIM_TINT_SCALE = 2;
    /** Per-variant tinted-sprite cache cap; beyond it sprites draw untinted. */
    const ANIM_TINT_CAP = 1024;
    /** Samples per exported operator curve (normalized age 0..1 inclusive). */
    const ANIM_LUT_N = 33;
    /** Cap on one frame's dt (s): a background tab's first tick must not jump. */
    const ANIM_DT_MAX = 0.1;

    /**
     * colorBlendMode → canvas composite operation for video layers. The
     * separable Photoshop modes composite as mix(A, F(A,B), opacity) — exactly
     * canvas's blend semantics with globalAlpha — and 31 (linear add) is
     * canvas `lighter` on the opaque flat-art backdrop. Modes without a canvas
     * equivalent fall back to source-over; WE's special-form modes (5, 10,
     * 30, 32) and the exotic Light/Phoenix family have not surfaced on video
     * layers yet.
     * @type {Record<number, GlobalCompositeOperation>}
     */
    const VIDEO_BLEND_OP = {
      1: "darken", 2: "multiply", 3: "color-burn", 6: "lighten", 7: "screen",
      8: "color-dodge", 9: "lighter", 11: "overlay", 12: "soft-light", 13: "hard-light",
      18: "difference", 19: "exclusion", 26: "hue", 27: "saturation", 28: "color",
      29: "luminosity", 31: "lighter",
    };

    const ANIM = {
      /** Mount generation: async fetches abort when a newer mount supersedes. */
      gen: 0,
      raf: 0,
      layer: null,
      canvas: null,
      ctx: null,
      frame: null,
      /** Flat art painted as the canvas base each frame (additive needs it). */
      art: null,
      /**
       * MP4 video layers stamped between the flat art and the particles:
       * `{ video, keyer, M, w, h, opacity, key }` per layer. `keyer` is the
       * offscreen chroma-keyer (null until the video's metadata loads, and for
       * layers without a colorkey effect, which draw the raw frame).
       */
      videos: [],
      units: [],
      images: [],
      /** Per-texture blending mode (`additive` selects canvas `lighter`). */
      texMeta: [],
      /** Per-texture pixel frame rects (UV frames × image size), or null. */
      frameRects: [],
      /** Per-texture h/w aspect for frameless sprites. */
      texAspect: [],
      tint: new Map(),
    };

    const randRange = (a, b) => a + Math.random() * (b - a);

    /** Linearly-interpolated sample of one exported operator curve. */
    function lutAt(lut, t) {
      const x = Math.max(0, Math.min(1, t)) * (ANIM_LUT_N - 1);
      const i = Math.floor(x);
      if (i >= ANIM_LUT_N - 1) return lut[ANIM_LUT_N - 1];
      return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
    }

    /** Linearly-interpolated per-channel sample of the color curve. */
    function colorLutAt(lut, t) {
      const x = Math.max(0, Math.min(1, t)) * (ANIM_LUT_N - 1);
      const i = Math.floor(x);
      const a = lut[Math.min(i, ANIM_LUT_N - 1)];
      const b = lut[Math.min(i + 1, ANIM_LUT_N - 1)];
      const f = x - i;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }

    /** Decode one texture-atlas PNG. */
    function loadAnimImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`texture ${url} failed`));
        img.src = url;
      });
    }

    /** Emitter spawn offset in system-local space (2D projection). */
    function emitterPos(spec) {
      const em = spec.emitters[0];
      if (!em) return [0, 0];
      let x = 0, y = 0;
      if (em.box) {
        x = randRange(em.distmin[0], em.distmax[0]);
        y = randRange(em.distmin[1], em.distmax[1]);
      } else {
        const rmin = Math.min(em.distmin[0], em.distmin[1]);
        const rmax = Math.max(em.distmax[0], em.distmax[1]);
        const r = rmin + Math.cbrt(Math.random()) * (rmax - rmin);
        const th = Math.random() * Math.PI * 2;
        x = r * Math.cos(th) * em.directions[0];
        y = r * Math.sin(th) * em.directions[1];
        if (em.sign[0]) x = Math.abs(x) * em.sign[0];
        if (em.sign[1]) y = Math.abs(y) * em.sign[1];
      }
      return [x + em.origin[0], y + em.origin[1]];
    }

    /**
     * Per-particle oscillation parameters (random at spawn like the reference
     * FrequencyValue storage): position keeps an INDEPENDENT random amplitude,
     * angular speed and phase per axis (the reference runs three separate
     * FrequencyValue copies, one per masked axis; GetMove integrates to
     * scale·(cos(w·t+phase)−cos(phase))); alpha/size share one lerp window
     * (GetScale).
     */
    function sampleOsc(spec) {
      const f = spec.ops;
      const base = (o) => ({
        w: randRange(o.freqmin, Math.max(o.freqmax, o.freqmin)),
        phase: Math.random() * Math.PI * 2,
      });
      const mul = (o) => ({ ...base(o), smin: o.scalemin, smax: o.scalemax });
      return {
        pos: f.oscPos ? {
          x: { ...base(f.oscPos), amp: randRange(f.oscPos.scalemin, f.oscPos.scalemax), on: f.oscPos.mask[0] > 0.01 },
          y: { ...base(f.oscPos), amp: randRange(f.oscPos.scalemin, f.oscPos.scalemax), on: f.oscPos.mask[1] > 0.01 },
        } : null,
        alpha: f.oscAlpha ? mul(f.oscAlpha) : null,
        size: f.oscSize ? mul(f.oscSize) : null,
      };
    }

    /**
     * (Re)spawn one particle into `p` (object identity kept: no per-frame GC).
     * Mirrors scene-art.js sampleInitState/sampleParticle; `age01` seeds the
     * first fill and keeps its remainder on respawn. WE pre-simulates a system
     * for `starttime` seconds before the first frame (controlled experiment,
     * 3013647681: starttime=15 loads at full steady state while starttime=3
     * ramps in), so an already-alive particle gets an age within
     * [0, min(preRoll, lifetime)] while an unborn one gets a negative age and
     * stays unpainted until emission reaches it.
     */
    function initParticle(spec, p, first, preRoll = 0, fill = 0) {
      const init = spec.init;
      const em = spec.emitters[0] ?? null;
      let L = randRange(init.lifetime[0], init.lifetime[1]);
      if (init.lifetime[0] === init.lifetime[1] && L > 0) L *= 1 + randRange(-0.05, 0.05);
      p.L = Math.max(L, 0.05);
      p.size0 = randRange(init.size[0], init.size[1]);
      p.alpha0 = randRange(init.alpha[0], init.alpha[1]);
      p.color0 = init.color
        ? [randRange(init.color[0][0], init.color[1][0]), randRange(init.color[0][1], init.color[1][1]), randRange(init.color[0][2], init.color[1][2])]
        : [1, 1, 1];
      let vel = [0, 0];
      if (init.vel) vel = [randRange(init.vel[0][0], init.vel[1][0]), randRange(init.vel[0][1], init.vel[1][1])];
      p.rot0 = init.rot ? randRange(init.rot[0][2], init.rot[1][2]) : 0;
      p.av = init.av ? randRange(init.av[0][2], init.av[1][2]) : 0;
      if (init.turb) {
        const s = randRange(init.turb.speed[0], init.turb.speed[1]);
        vel[0] += randRange(-1, 1) * s * init.turb.mask[0];
        vel[1] += randRange(-1, 1) * s * init.turb.mask[1];
      }
      p.frameRoll = Math.random();
      if (!init.vel && em && (em.speedmin !== 0 || em.speedmax !== 0)) {
        const [ex, ey] = emitterPos(spec);
        const len = Math.hypot(ex, ey);
        vel = len > 1e-6
          ? [(randRange(em.speedmin, em.speedmax) * ex) / len, (randRange(em.speedmin, em.speedmax) * ey) / len]
          : [0, 0];
      }
      p.vel = vel;
      const pos = emitterPos(spec);
      p.spawn = [pos[0], pos[1]];
      p.osc = sampleOsc(spec);
      if (first) {
        // First births stagger across the fill window (the pre-roll span when
        // nothing fills): born before load carries a pre-simulated age within
        // this life; the rest stay negative until emission reaches them.
        const stagger = fill > 0 ? fill : preRoll;
        if (stagger <= 0) p.age01 = Math.random();
        else {
          const birth = Math.random() * stagger;
          p.age01 = birth <= preRoll
            ? ((preRoll - birth) % p.L) / p.L
            : (preRoll - birth) / p.L;
        }
      }
    }

    /** Analytic trajectory position at age `t` seconds (oscillation excluded). */
    function trajAt(spec, p, t) {
      const mv = spec.ops.movement;
      let x = p.spawn[0];
      let y = p.spawn[1];
      if (mv && (mv.gravity[0] || mv.gravity[1] || mv.drag > 0)) {
        const g = mv.gravity;
        if (mv.drag > 1e-6) {
          const k = (1 - Math.exp(-mv.drag * t)) / mv.drag;
          x += p.vel[0] * k + (g[0] / mv.drag) * (t - k);
          y += p.vel[1] * k + (g[1] / mv.drag) * (t - k);
        } else {
          x += p.vel[0] * t + 0.5 * g[0] * t * t;
          y += p.vel[1] * t + 0.5 * g[1] * t * t;
        }
      } else {
        x += p.vel[0] * t;
        y += p.vel[1] * t;
      }
      const vortex = spec.ops.vortex;
      if (vortex) {
        const dx = x - vortex.origin[0];
        const dy = y - vortex.origin[1];
        const r = Math.hypot(dx, dy);
        const span = vortex.distOuter - vortex.distInner;
        const kk = span > 1e-6
          ? Math.max(0, Math.min(1, (r - vortex.distInner) / span))
          : (r > vortex.distInner ? 1 : 0);
        const speed = vortex.speedInner + (vortex.speedOuter - vortex.speedInner) * kk;
        const w = r > 1e-6 ? (speed / r) * t : 0;
        if (w !== 0) {
          const c = Math.cos(w), s = Math.sin(w);
          x = vortex.origin[0] + dx * c - dy * s;
          y = vortex.origin[1] + dx * s + dy * c;
        }
      }
      return [x, y];
    }

    /** Rotation at age `t`: reference angularmovement integration. */
    function rotAt(spec, p, t) {
      const ang = spec.ops.angular;
      if (!ang) return p.rot0 + p.av * t;
      if (ang.drag > 1e-6) {
        const k = (1 - Math.exp(-ang.drag * t)) / ang.drag;
        return p.rot0 + p.av * k + (ang.force / ang.drag) * (t - k);
      }
      return p.rot0 + p.av * t + 0.5 * ang.force * t * t;
    }

    /** Sprite-sheet frame index at the particle's phase. */
    function frameIndexOf(spec, p, n) {
      if (spec.animationmode === "randomframe") {
        return Math.max(0, Math.min(n - 1, Math.floor(p.frameRoll * n)));
      }
      return Math.max(0, Math.min(n - 1, Math.floor(p.age01 * spec.seqx * n)));
    }

    /**
     * Tinted sprite variant (frame sub-rect premultiplied by one RGB color at
     * ANIM_TINT_SCALE resolution), cached by quantized color. The reference
     * shader multiplies the texture RGB by the particle color; near-white
     * tints draw the raw texture instead (cache never fills with no-ops).
     * @returns {HTMLCanvasElement | null} Tinted sprite, or null when the
     *   tint is a no-op or the cache is full.
     */
    function tintedSprite(texIdx, frame, color, img) {
      const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * 15);
      const key = `${texIdx}:${frame ? frame.i : -1}:${q(color[0])}:${q(color[1])}:${q(color[2])}`;
      const hit = ANIM.tint.get(key);
      if (hit) return hit;
      if (ANIM.tint.size >= ANIM_TINT_CAP) return null;
      const fw = frame ? frame.w : img.width;
      const fh = frame ? frame.h : img.height;
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.ceil(fw * ANIM_TINT_SCALE));
      cv.height = Math.max(1, Math.ceil(fh * ANIM_TINT_SCALE));
      const c2 = cv.getContext("2d");
      const sx = frame ? frame.x : 0;
      const sy = frame ? frame.y : 0;
      c2.drawImage(img, sx, sy, fw, fh, 0, 0, cv.width, cv.height);
      c2.globalCompositeOperation = "multiply";
      c2.fillStyle = `rgb(${q(color[0]) * 17},${q(color[1]) * 17},${q(color[2]) * 17})`;
      c2.fillRect(0, 0, cv.width, cv.height);
      c2.globalCompositeOperation = "destination-in";
      c2.drawImage(img, sx, sy, fw, fh, 0, 0, cv.width, cv.height);
      ANIM.tint.set(key, cv);
      return cv;
    }

    /**
     * Offscreen WebGL chroma-keyer for one MP4 video layer, a faithful port
     * of Wallpaper Engine's colorkey.frag: the L1 distance of the frame's RGB
     * to the key color ramps through smoothstep(tolerance, tolerance +
     * fuzziness), and the kept fraction mixes the alpha toward the effect's
     * authored `alpha` inside the key. The keyed frame lands upright on the
     * keyer's own canvas, which drawAnimFrame stamps through the layer
     * matrix. Every surveyed colorkey uses the default INVERT/FLATTEN combos,
     * so the port keeps them off.
     * @param {{ color: number[], tolerance: number, fuzziness: number, alpha: number }} key
     *   Exported colorkey parameters.
     * @param {number} w Keyer canvas width (the video's native width).
     * @param {number} h Keyer canvas height (the video's native height).
     * @returns {{ canvas: HTMLCanvasElement, render: (video: HTMLVideoElement) => boolean, dispose: () => void } | null}
     *   Keyer, or null when WebGL is unavailable.
     */
    function createVideoKeyer(key, w, h) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      // Straight (non-premultiplied) output alpha: the anim canvas composites
      // the partial-alpha key edge with source-over, and premultiplying here
      // would double-darken it.
      const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) return null;
      const VERT = "attribute vec2 aPos; varying vec2 vUv;" +
        "void main(){gl_Position=vec4(aPos,0.0,1.0);vUv=vec2(aPos.x*0.5+0.5,0.5-aPos.y*0.5);}";
      const FRAG = "precision mediump float; varying vec2 vUv; uniform sampler2D uTex;" +
        "uniform vec3 uKey; uniform float uTol; uniform float uFuzz; uniform float uAlpha;" +
        "void main(){vec4 albedo=texture2D(uTex,vUv);" +
        "float delta=dot(abs(uKey-albedo.rgb),vec3(1.0,1.0,1.0));" +
        "float blend=smoothstep(0.001,0.002+uFuzz,delta-uTol);" +
        "gl_FragColor=vec4(albedo.rgb,albedo.a*mix(uAlpha,1.0,blend));}";
      const compile = (type, src) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
      };
      const vert = compile(gl.VERTEX_SHADER, VERT);
      const frag = compile(gl.FRAGMENT_SHADER, FRAG);
      const prog = gl.createProgram();
      if (!vert || !frag) return null;
      gl.attachShader(prog, vert);
      gl.attachShader(prog, frag);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform3f(gl.getUniformLocation(prog, "uKey"), key.color[0], key.color[1], key.color[2]);
      gl.uniform1f(gl.getUniformLocation(prog, "uTol"), key.tolerance);
      gl.uniform1f(gl.getUniformLocation(prog, "uFuzz"), key.fuzziness);
      gl.uniform1f(gl.getUniformLocation(prog, "uAlpha"), key.alpha);
      gl.viewport(0, 0, canvas.width, canvas.height);
      return {
        canvas,
        render(video) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          } catch {
            // A video torn down mid-frame surfaces as a texture-upload error;
            // skipping the draw leaves the previous keyed frame untouched.
            return false;
          }
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          return true;
        },
        dispose() {
          const lose = gl.getExtension("WEBGL_lose_context");
          if (lose) lose.loseContext();
        },
      };
    }

    /**
     * Expand the exported systems into flat render units: every spec with a
     * texture becomes one unit carrying its local→projection matrix (static
     * child origins precomposed, matching walkParticleSystem). Event children
     * are skipped — the static composite documents the same omission.
     */
    function buildAnimUnits(meta) {
      const units = [];
      const expand = (spec, M, alpha, offset, depth) => {
        if (!spec || depth > 8) return;
        const [ox, oy] = offset;
        const M2 = [
          M[0], M[1], M[2], M[3],
          M[4] + M[0] * ox + M[2] * oy,
          M[5] + M[1] * ox + M[3] * oy,
        ];
        if (spec.tex != null && spec.count > 0 && ANIM.images[spec.tex]) {
          // The pool fills over count/rate seconds (capped at the average
          // lifetime); `starttime` pre-rolls the simulation, so the first
          // fill sees particles mid-life or still unborn — never delayed
          // behind starttime + fill.
          const rate = (spec.emitters ?? []).reduce((s, e) => s + (e.rate ?? 0), 0);
          const [la, lb] = spec.init.lifetime;
          const fill = rate > 0 ? Math.min(spec.count / rate, (la + lb) / 2) : 0;
          const preRoll = typeof spec.starttime === "number" ? spec.starttime : 0;
          // WE instances the pool on the GPU; instanceoverride count=2 presets
          // (Violet's Particle_flow ships 50k sprites) exceed a 2D canvas
          // frame budget, so the replay keeps a per-system ceiling.
          const n = Math.min(spec.count, 12000);
          const particles = [];
          for (let i = 0; i < n; i++) {
            const p = { age01: 0 };
            initParticle(spec, p, true, preRoll, fill);
            particles.push(p);
          }
          units.push({ M: M2, alpha, spec, particles });
        }
        for (const c of spec.children ?? []) {
          if (c.type === "static" && c.spec) {
            expand(c.spec, M, alpha, [offset[0] + c.origin[0], offset[1] + c.origin[1]], depth + 1);
          }
        }
      };
      for (const sys of meta.systems) expand(sys.spec, sys.M, sys.alpha, [0, 0], 0);
      return units;
    }

    /**
     * Render one animation frame: advance every particle's age (respawning
     * expired slots), then stamp the sprites through each unit's matrix with
     * the cover transform the body background uses. The per-sprite chain
     * translate→rotate→scale(1,-1) reproduces scene-art.js paintParticleSprite
     * corner math (local space is y-up; the texture's v axis points down).
     */
    function drawAnimFrame(dt) {
      const ctx = ANIM.ctx;
      const frame = ANIM.frame;
      if (!ctx || !frame) return;
      for (const unit of ANIM.units) {
        for (const p of unit.particles) {
          p.age01 += dt / p.L;
          if (p.age01 >= 1) {
            initParticle(unit.spec, p, false);
            p.age01 %= 1;
          }
        }
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(1, Math.round(vw * dpr));
      const ch = Math.max(1, Math.round(vh * dpr));
      if (ANIM.canvas.width !== cw || ANIM.canvas.height !== ch) {
        ANIM.canvas.width = cw;
        ANIM.canvas.height = ch;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const cover = Math.max(vw / frame.w, vh / frame.h);
      const ox = (vw - frame.w * cover) / 2;
      const oy = (vh - frame.h * cover) / 2;
      // Paint the flat art as the frame base: additive sprites below blend
      // with `lighter` and only lighten real scene pixels — on a transparent
      // canvas their opaque black texture backgrounds would survive the
      // element's source-over composite and show as dark squares. The base
      // uses the same cover math as the body background it covers.
      if (ANIM.art) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(ANIM.art, dpr * ox, dpr * oy, dpr * frame.w * cover, dpr * frame.h * cover);
      }
      // MP4 video layers ride between the flat art and the particles (the
      // riding order scene-art.js documents for its static composite). Each
      // layer keys its current frame offscreen, then stamps it through the
      // exported matrix with the cover transform; the quad transform mirrors
      // scene-art.js paintLayer's texToCanvas — the frame's v axis points
      // down while world space is y-up.
      for (const v of ANIM.videos) {
        if (v.video.readyState < 2) continue;
        let source;
        if (v.key) {
          if (!v.keyer) continue;
          if (!v.keyer.render(v.video)) continue;
          source = v.keyer.canvas;
        } else {
          source = v.video;
        }
        const vw = v.video.videoWidth || v.w;
        const vh = v.video.videoHeight || v.h;
        if (vw <= 0 || vh <= 0) continue;
        ctx.globalAlpha = v.opacity;
        ctx.globalCompositeOperation = VIDEO_BLEND_OP[v.blend] ?? "source-over";
        ctx.setTransform(dpr * cover, 0, 0, dpr * cover, dpr * ox, dpr * oy);
        ctx.transform(v.M[0], v.M[1], v.M[2], v.M[3], v.M[4], v.M[5]);
        ctx.transform(v.w / vw, 0, 0, -(v.h / vh), -v.w / 2, v.h / 2);
        ctx.drawImage(source, 0, 0);
      }
      for (const unit of ANIM.units) {
        const spec = unit.spec;
        const ops = spec.ops;
        const texIdx = spec.tex;
        const texMeta = ANIM.texMeta[texIdx];
        const img = ANIM.images[texIdx];
        const frames = ANIM.frameRects[texIdx];
        const baseAspect = ANIM.texAspect[texIdx];
        ctx.globalCompositeOperation = texMeta.blending === "additive" ? "lighter" : "source-over";
        ctx.setTransform(dpr * cover, 0, 0, dpr * cover, dpr * ox, dpr * oy);
        ctx.transform(unit.M[0], unit.M[1], unit.M[2], unit.M[3], unit.M[4], unit.M[5]);
        for (const p of unit.particles) {
          if (p.age01 <= 0) continue; // unborn: negative age before its first birth
          const age = p.age01 * p.L;
          const age01 = p.age01;
          let alpha = p.alpha0 * lutAt(ops.alphaLUT, age01);
          let size = p.size0 * lutAt(ops.sizeLUT, age01);
          let color = p.color0;
          if (ops.colorLUT) {
            const c = colorLutAt(ops.colorLUT, age01);
            color = [p.color0[0] * c[0], p.color0[1] * c[1], p.color0[2] * c[2]];
          }
          if (p.osc.alpha) alpha *= p.osc.alpha.smin + (p.osc.alpha.smax - p.osc.alpha.smin) * (Math.cos(p.osc.alpha.w * age + p.osc.alpha.phase) + 1) / 2;
          if (p.osc.size) size *= p.osc.size.smin + (p.osc.size.smax - p.osc.size.smin) * (Math.cos(p.osc.size.w * age + p.osc.size.phase) + 1) / 2;
          if (alpha <= 0.004 || size <= 0.5) continue;
          const pos = trajAt(spec, p, age);
          let cx = pos[0], cy = pos[1];
          if (p.osc.pos) {
            const px = p.osc.pos.x, py = p.osc.pos.y;
            if (px.on) cx += px.amp * (Math.cos(px.w * age + px.phase) - Math.cos(px.phase));
            if (py.on) cy += py.amp * (Math.cos(py.w * age + py.phase) - Math.cos(py.phase));
          }
          const fi = frames ? frames[frameIndexOf(spec, p, frames.length)] : null;
          const w = size;
          const h = size * (fi ? fi.aspect : baseAspect);
          const white = color[0] >= 0.97 && color[1] >= 0.97 && color[2] >= 0.97;
          const tinted = white ? null : tintedSprite(texIdx, fi, color, img);
          ctx.globalAlpha = alpha * unit.alpha;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rotAt(spec, p, age));
          ctx.scale(1, -1);
          if (tinted) ctx.drawImage(tinted, 0, 0, tinted.width, tinted.height, -w / 2, -h / 2, w, h);
          else if (fi) ctx.drawImage(img, fi.x, fi.y, fi.w, fi.h, -w / 2, -h / 2, w, h);
          else ctx.drawImage(img, -w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /** Tear the animation overlay down and invalidate in-flight mounts. */
    function stopSceneAnim() {
      ANIM.gen++;
      if (ANIM.raf) cancelAnimationFrame(ANIM.raf);
      ANIM.raf = 0;
      if (ANIM.layer) ANIM.layer.remove();
      ANIM.layer = null;
      ANIM.canvas = null;
      ANIM.ctx = null;
      ANIM.frame = null;
      ANIM.art = null;
      for (const v of ANIM.videos) {
        v.video.pause();
        v.video.removeAttribute("src");
        // load() with no src aborts the in-flight MP4 fetch and releases the
        // decoder without waiting for garbage collection.
        v.video.load();
        if (v.keyer) v.keyer.dispose();
      }
      ANIM.videos = [];
      ANIM.units = [];
      ANIM.images = [];
      ANIM.texMeta = [];
      ANIM.frameRects = [];
      ANIM.texAspect = [];
      ANIM.tint.clear();
    }

    /**
     * Create the detached video elements for the exported MP4 layers and
     * their chroma-keyers. The elements stay out of the document: Chromium
     * decodes muted detached videos fine, and an unkeyed frame (the chroma
     * backdrop) must never reach the compositor. A keyer materializes on
     * loadedmetadata, when the video's native size is known.
     * @param {string} id Workshop id.
     * @param {{ w: number, h: number, videos: object[] }} videoMeta The scene-video export.
     * @param {number} gen Mount generation the videos belong to.
     */
    function setupSceneVideos(id, videoMeta, gen) {
      ANIM.videos = videoMeta.videos.map((v, i) => {
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.disablePictureInPicture = true;
        video.preload = "auto";
        video.src = `/plugin-wallpaper/scene-video/${id}/${i}`;
        const entry = {
          video,
          keyer: null,
          M: Array.isArray(v.M) ? v.M : [1, 0, 0, 1, 0, 0],
          w: Number(v.w) || 1,
          h: Number(v.h) || 1,
          opacity: typeof v.opacity === "number" ? v.opacity : 1,
          key: v.key ?? null,
          blend: typeof v.blend === "number" ? v.blend : 0,
        };
        if (entry.key) {
          video.addEventListener("loadedmetadata", () => {
            if (ANIM.gen !== gen) return;
            entry.keyer = createVideoKeyer(entry.key, video.videoWidth || entry.w, video.videoHeight || entry.h);
          }, { once: true });
        }
        video.play().catch(() => { /* muted autoplay needs no gesture; a rejection leaves the paused first frame to draw */ });
        return entry;
      });
    }

    /**
     * Mount the live overlay for one scene wallpaper — its particle systems
     * and/or MP4 video layers: fetch the animation and video exports, the
     * texture atlases and the flat art the canvas paints as its base, then
     * run the loop. Any failure calls `fallback` (the caller swaps the art to
     * the composite with the baked particles); a superseded mount does
     * nothing. The art must load before the first frame — without it additive
     * sprites would draw their opaque black texture backgrounds onto a
     * transparent canvas and composite as dark squares over the page.
     * @param {string} id Workshop id.
     * @param {() => void} fallback Called when neither export can run.
     * @param {string} artSrc Flat-art URL the canvas repaints every frame.
     */
    async function startSceneAnim(id, fallback, artSrc) {
      stopSceneAnim();
      const gen = ANIM.gen;
      let art = null;
      let meta = null;
      let videoMeta = null;
      try {
        meta = await apiGet(`/plugin-wallpaper/scene-anim/${id}`).catch(() => null);
        videoMeta = await apiGet(`/plugin-wallpaper/scene-video/${id}`).catch(() => null);
        const hasAnim = !!meta && Array.isArray(meta.systems) && meta.systems.length > 0 && Array.isArray(meta.textures);
        const hasVideos = !!videoMeta && Array.isArray(videoMeta.videos) && videoMeta.videos.length > 0
          && Number(videoMeta.w) > 0 && Number(videoMeta.h) > 0;
        if (!hasAnim && !hasVideos) {
          throw new Error("empty animation export");
        }
        art = await loadAnimImage(artSrc);
        if (ANIM.gen !== gen) return;
        if (hasAnim) {
          for (let i = 0; i < meta.textures.length; i++) {
            const img = await loadAnimImage(`/plugin-wallpaper/scene-anim-tex/${id}/${i}`);
            if (ANIM.gen !== gen) return;
            ANIM.images.push(img);
            const t = meta.textures[i];
            ANIM.texMeta.push({ blending: t.blending });
            ANIM.frameRects.push(t.frames ? t.frames.map((f, idx) => ({
              i: idx,
              x: f.u0 * img.width,
              y: f.v0 * img.height,
              w: (f.u1 - f.u0) * img.width,
              h: (f.v1 - f.v0) * img.height,
              aspect: f.aspect,
            })) : null);
            ANIM.texAspect.push(img.height / img.width);
          }
        }
        if (hasVideos) setupSceneVideos(id, videoMeta, gen);
      } catch {
        if (ANIM.gen === gen) fallback();
        return;
      }
      if (ANIM.gen !== gen) return;
      const layer = document.createElement("div");
      layer.id = ANIM_LAYER_ID;
      const canvas = document.createElement("canvas");
      layer.appendChild(canvas);
      document.body.appendChild(layer);
      ANIM.layer = layer;
      ANIM.canvas = canvas;
      ANIM.ctx = canvas.getContext("2d");
      ANIM.frame = meta ? { w: meta.w, h: meta.h } : { w: videoMeta.w, h: videoMeta.h };
      ANIM.art = art;
      ANIM.units = meta ? buildAnimUnits(meta) : [];
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min((now - last) / 1000, ANIM_DT_MAX);
        last = now;
        drawAnimFrame(dt);
        ANIM.raf = requestAnimationFrame(tick);
      };
      ANIM.raf = requestAnimationFrame(tick);
    }

    /**
     * Verify the art URL decodes as a real image. A stale/corrupt 200 body
     * fails CSS background rendering without falling through to the poster
     * layer (the browser treats the layer as present), leaving a blank page —
     * so probe it and drop the art layer to `none` on decode failure, letting
     * the poster layer show. Guarded by the URL: a newer mount that already
     * swapped the variable is left alone.
     * @param {string} src Art URL to verify.
     */
    function verifyArtLoads(src) {
      const body = document.body;
      const img = new Image();
      const stale = () => body.style.getPropertyValue("--dshWp-art") !== `url("${src}")`;
      img.onload = () => { if (img.naturalWidth === 0 && !stale()) body.style.setProperty("--dshWp-art", "none"); };
      img.onerror = () => { if (!stale()) body.style.setProperty("--dshWp-art", "none"); };
      img.src = src;
    }

    /**
     * Mount the whole-page background and make the app surfaces transparent.
     * Render modes: `video` plays the original wallpaper file and `frame`
     * loads a web wallpaper's html entry in an iframe (its own animations
     * and particle effects run natively) — both on a fixed layer behind the
     * app. `image` instead paints the wallpaper as the page's opaque root
     * background: body background stacking (art over poster over a solid
     * fallback color) with no layer element at all, because a transparent
     * root makes Chromium drop subpixel text antialiasing document-wide.
     * Scene wallpapers additionally replay their particle systems and MP4
     * video layers live on a canvas above that root background: the art URL
     * carries `?flat=1` (no baked particles), the canvas repaints that same
     * flat art as its base so additive sprites blend against real scene
     * pixels, and when neither export is usable the art falls back to the
     * composite with the baked steady state. The poster layer bridges the seconds a first scene-art
     * extraction can take (the art request is held open until the extraction
     * finishes) and stays as the fallback when the art URL is unusable.
     * Adaptive ink sampling starts with the mount.
     * @param {object} state - `/plugin-wallpaper/state` payload with mode/src.
     */
    function mountBackground(state) {
      if (!state || !state.id || !state.src || typeof document === "undefined" || !document.body) return;
      const body = document.body;
      if (state.mode === "image") {
        const stale = document.getElementById(BG_LAYER_ID);
        if (stale) stale.remove();
        const liveParticles = state.type === "scene";
        const artSrc = liveParticles ? `${state.src}?flat=1` : state.src;
        body.style.setProperty("--dshWp-art", `url("${artSrc}")`);
        body.style.setProperty("--dshWp-poster", state.poster ? `url("${state.poster}")` : "none");
        body.classList.add(BG_ON_CLASS, BG_IMG_CLASS);
        verifyArtLoads(artSrc);
        if (liveParticles) {
          startSceneAnim(state.id, () => {
            body.style.setProperty("--dshWp-art", `url("${state.src}")`);
            verifyArtLoads(state.src);
          }, artSrc);
          startAdaptive({ ...state, src: artSrc });
        } else {
          stopSceneAnim();
          startAdaptive(state);
        }
        return;
      }
      stopSceneAnim();
      unmarkImageBackground(body);
      let layer = document.getElementById(BG_LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = BG_LAYER_ID;
        document.body.appendChild(layer);
      }
      layer.innerHTML = "";
      if (state.mode === "frame") {
        const frame = document.createElement("iframe");
        frame.src = state.src;
        frame.allow = "autoplay; fullscreen";
        frame.title = "background";
        layer.appendChild(frame);
      } else {
        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.disablePictureInPicture = true;
        if (state.poster) video.poster = state.poster;
        video.src = state.src;
        layer.appendChild(video);
      }
      body.classList.add(BG_ON_CLASS);
      startAdaptive(state);
    }

    /** Remove the background layer and restore the default app background. */
    function clearBackground() {
      const layer = document.getElementById(BG_LAYER_ID);
      if (layer) layer.remove();
      stopSceneAnim();
      stopAdaptive();
      if (typeof document !== "undefined" && document.body) {
        document.body.classList.remove(BG_ON_CLASS);
        unmarkImageBackground(document.body);
      }
    }

    // ── section component ──────────────────────────────────────────────────

    /**
     * The 壁纸 settings section: current-background status, a title search and
     * a lazy-loaded preview grid. Clicking a card sets that wallpaper as the
     * whole-page DeepSeek Harness background — video wallpapers play their
     * original file, web wallpapers load in an iframe with their animations and
     * particle effects intact, scene and image wallpapers render their real
     * art full-bleed.
     * Each card also carries a small 桌面 button that applies it as the desktop
     * wallpaper through Wallpaper Engine.
     * @param props - composed settings.section slot props (unused).
     * @returns the section element tree.
     */
    function WallpaperSection(_props) {
      const [phase, setPhase] = React.useState("loading");
      const [data, setData] = React.useState(null);
      const [uiState, setUiState] = React.useState(null);
      const [query, setQuery] = React.useState("");
      const [applyingId, setApplyingId] = React.useState("");
      const [deskId, setDeskId] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);

      const load = React.useCallback(async () => {
        setPhase("loading");
        setNotice("");
        try {
          const [list, state] = await Promise.all([
            apiGet("/plugin-wallpaper/list"),
            apiGet("/plugin-wallpaper/state"),
          ]);
          if (!alive.current) return;
          setData(list);
          setUiState(state);
          setPhase("ready");
          if (list.error) setNotice(list.error);
        } catch (error) {
          if (!alive.current) return;
          setNotice(String(error?.message ?? error));
          setPhase("error");
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const setAppBackground = React.useCallback(async (id) => {
        if (applyingId) return;
        setApplyingId(id);
        setNotice("");
        try {
          const state = await apiPost("/plugin-wallpaper/state", { id });
          if (!alive.current) return;
          setUiState(state);
          mountBackground(state);
        } catch (error) {
          if (alive.current) setNotice(String(error?.message ?? error));
        } finally {
          if (alive.current) setApplyingId("");
        }
      }, [applyingId]);

      const chooseLocalBackground = React.useCallback(async () => {
        if (applyingId) return;
        setApplyingId("local");
        setNotice("");
        try {
          const path = await pickWallpaperFile();
          if (!path) return;
          const state = await apiPost("/plugin-wallpaper/state", { selection: { kind: "local", path } });
          if (!alive.current) return;
          setUiState(state);
          mountBackground(state);
        } catch (error) {
          if (alive.current) setNotice(String(error?.message ?? error));
        } finally {
          if (alive.current) setApplyingId("");
        }
      }, [applyingId]);

      const resetBackground = React.useCallback(async () => {
        if (applyingId) return;
        setApplyingId("reset");
        setNotice("");
        try {
          const state = await apiPost("/plugin-wallpaper/state", { id: "" });
          if (!alive.current) return;
          setUiState(state);
          clearBackground();
        } catch (error) {
          if (alive.current) setNotice(String(error?.message ?? error));
        } finally {
          if (alive.current) setApplyingId("");
        }
      }, [applyingId]);

      const applyDesktop = React.useCallback(async (id) => {
        if (deskId) return;
        setDeskId(id);
        setNotice("");
        try {
          const result = await apiPost("/plugin-wallpaper/apply", { id });
          if (!alive.current) return;
          if (result.ok && result.verified === false) {
            setNotice(`已发送「${result.title}」,但未能确认生效`);
          } else if (!result.ok) {
            setNotice(result.error || "应用失败");
          }
        } catch (error) {
          if (alive.current) setNotice(String(error?.message ?? error));
        } finally {
          if (alive.current) setDeskId("");
          load();
        }
      }, [deskId, load]);

      const filtered = React.useMemo(() => {
        const all = data?.wallpapers ?? [];
        const q = query.trim().toLowerCase();
        if (!q) return all;
        return all.filter((w) => w.title.toLowerCase().includes(q));
      }, [data, query]);

      if (phase === "loading") {
        return h("div", { className: css.section },
          h("p", { className: css.hint }, "正在读取壁纸…"));
      }

      if (phase === "error") {
        return h("div", { className: css.section },
          h("p", { className: css.notice }, notice || "读取失败"),
          h("button", { type: "button", className: css.btn + " " + css.retry, onClick: load }, "重试"));
      }

      const currentId = uiState?.id ?? "";

      return h("div", { className: css.section },
        h("div", { className: css.toolbar },
          h("span", { className: css.status, title: currentId ? uiState.title : undefined },
            currentId ? h("span", null, "当前背景:", h("b", null, uiState.title)) : "未设置背景"),
          h("button", {
            type: "button",
            className: css.btn,
            disabled: !!applyingId || !currentId,
            onClick: resetBackground,
          }, "恢复默认"),
          h("button", {
            type: "button",
            className: css.btn,
            disabled: !!applyingId,
            onClick: chooseLocalBackground,
          }, applyingId === "local" ? "选择中…" : "选择本地壁纸"),
          h("button", {
            type: "button",
            className: css.btn + " " + css.btnIcon,
            onClick: load,
            title: "刷新列表",
          },
            h(primitives.IconRefreshOutline16, { size: 14, "aria-hidden": "true" }),
            "刷新")),
        h("label", { className: css.search },
          h(primitives.IconSearchOutline16, { size: 16, "aria-hidden": "true" }),
          h("input", {
            type: "text",
            value: query,
            placeholder: "搜索壁纸标题…",
            onChange: (e) => setQuery(e.currentTarget.value),
          })),
        notice ? h("p", { className: css.notice }, notice) : null,
        h("p", { className: css.hint },
          `共 ${data.total} 个壁纸 · ${filtered.length} 个匹配 · 点击卡片设为整页背景 · 视频/网页/场景类有完整动效`),
        filtered.length === 0
          ? h("p", { className: css.hint }, "没有匹配的壁纸。")
          : h("div", { className: css.grid },
            filtered.map((w) => {
              const isCurrent = !!currentId && w.id === currentId;
              const isApplying = applyingId === w.id;
              const isDeskBusy = deskId === w.id;
              return h("div", {
                key: w.id,
                role: "button",
                tabIndex: 0,
                className: css.card,
                "data-current": isCurrent ? "true" : undefined,
                "data-busy": isApplying ? "true" : undefined,
                onClick: () => setAppBackground(w.id),
                onKeyDown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setAppBackground(w.id);
                  }
                },
                title: w.title,
              },
                h("div", { className: css.thumbWrap },
                  w.preview
                    ? h("img", {
                      className: css.thumb,
                      src: w.preview,
                      alt: "",
                      loading: "lazy",
                      onError: (e) => { e.currentTarget.remove(); },
                    })
                    : h("div", { className: css.thumbFallback }, typeLabel(w.type)),
                  h("button", {
                    type: "button",
                    className: css.deskBtn,
                    "data-busy": isDeskBusy ? "true" : undefined,
                    disabled: !!deskId,
                    onClick: (e) => {
                      e.stopPropagation();
                      applyDesktop(w.id);
                    },
                    title: "应用为桌面壁纸(Wallpaper Engine)",
                  }, isDeskBusy ? "桌面…" : "桌面")),
                h("div", { className: css.cardBody },
                  h("div", { className: css.cardTitle }, w.title),
                  h("div", { className: css.cardMeta },
                    h("span", { className: css.type }, typeLabel(w.type)),
                    isCurrent ? h("span", { className: css.current }, "使用中") : null,
                    isApplying ? h("span", { className: css.current }, "设置中…") : null)));
            })));
    }

    // ── plugin face ────────────────────────────────────────────────────────

    const inject = ["slots"];

    /**
     * Mount the persisted app background, then register the 壁纸 section into
     * the settings modal once the `settings.section` slot declaration is on the
     * ledger.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      apiGet("/plugin-wallpaper/state")
        .then((state) => { if (state && state.id) mountBackground(state); })
        .catch(() => {});
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "wallpaper",
        order: 25,
        label: () => "壁纸",
      }, WallpaperSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
