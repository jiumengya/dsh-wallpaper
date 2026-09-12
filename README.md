# dsh-wallpaper — Wallpaper Engine plugin for DeepSeek Harness

Connects the desktop edition of DeepSeek Harness to Wallpaper Engine: set any wallpaper as the **DeepSeek Harness app background** from the **Wallpaper section of the settings panel** (video wallpapers play back the original video directly); it also gives the agent 4 tools for controlling the desktop Wallpaper Engine.

## Prerequisites

- Steam and Wallpaper Engine installed (any Steam library location works; auto-discovered)
- DshNative desktop app installed (rc.17 or newer)

## Installation

Right-click `install.ps1` → **Run with PowerShell** (or:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

The script does three things:
1. Copies the plugin package to `%LOCALAPPDATA%\DshNative\runtime\node_modules\@deepseek-ai\dsh-wallpaper`
2. Creates a `~\.dsh\profiles\node_modules\@deepseek-ai\dsh-wallpaper` junction (required for profile resolution)
3. Generates a `%LOCALAPPDATA%\DshNative\desktop.yml` overlay (the data-directory overlay takes priority over the app directory, no admin rights needed), appending this plugin to the app's built-in entries

**Takes effect after restarting DeepSeek Harness.**

## Usage

**Change the app background (graphical UI)**: click the ⚙ settings button at the bottom of the left sidebar, then click the **Wallpaper** section in the left navigation — the top shows the current background, a search box filters by title, and below is a grid of preview thumbnails: **click any card to set it as the full-page background** (the entire interface, including behind the sidebar, shows the wallpaper with no overlay mask). "Restore default" reverts in one click. Cards are labeled with their animation support: **web type = full animation, video type = animation, scene type = real-time particle animation** (scene is a Wallpaper Engine proprietary format that browsers cannot natively render; the backend extracts layers from scene.pkg to compose a static base image, and the particle system is exported as a pure data definition that the frontend canvas simulates frame-by-frame in real time — petals/snow/light dust drift across the whole page with the same physical semantics as Wallpaper Engine; more complex effects such as skeletal-bound animations are still only available for web/video types). Each card's thumbnail also has a small "desktop" button that appears in the top-right on hover, letting you set it as the desktop wallpaper (via Wallpaper Engine). The selection persists in `~\.dsh\plugin-wallpaper-ui.json` and is restored automatically after restart.

You can also talk to the agent in natural language (operating the **desktop** Wallpaper Engine):

- "List the wallpapers I have installed"
- "Change to a wallpaper related to Hatsune Miku"
- "What wallpaper am I using right now"
- "Pause wallpaper" "mute wallpaper" "hide desktop icons" "next wallpaper"

The 4 tools provided:

| Tool | Purpose |
|------|---------|
| `wallpaper_list` | List installed wallpapers (id/title/type), with title filtering |
| `wallpaper_apply` | Apply a wallpaper by workshop id or title, optional monitor; auto-starts Wallpaper Engine if not running, then reads back the config to confirm |
| `wallpaper_control` | pause / play / stop / mute / unmute / next / close / hide_icons / show_icons |
| `wallpaper_current` | Show the current wallpaper (path + title) |

## Configuration (optional)

When Steam or Wallpaper Engine is installed in a special location, edit the plugin entry in `%LOCALAPPDATA%\DshNative\desktop.yml`:

```yaml
- insert:
    - id: wallpaper
      name: '@deepseek-ai/dsh-wallpaper'
      config:
        steamPath: 'E:\Steam'            # Steam root directory (default: auto-discovered from the registry)
        wallpaperEnginePath: ''           # full path to wallpaper64.exe (default: auto-discovered from the Steam library)
```

## Uninstall

Right-click `uninstall.ps1` → **Run with PowerShell**. Removes the plugin package and link, and deletes the data-directory overlay (the app reverts to the overlay shipped with its install directory).

## Implementation notes

- **App background (full page, two mounting modes)**: once selected, the official UI's large opaque backgrounds are all made transparent (`--dsw-alias-bg-base`, `--dsw-specific-sidebar-fill`; the input box `--dsw-specific-input-major` becomes a semi-transparent glass color, one set per light/dark theme) — the wallpaper runs through the whole page including behind the sidebar; content panels such as message cards keep their own backgrounds for readability, with no overlay veil. **Image/scene wallpapers are drawn directly as the opaque root background of `body` itself** (CSS double-layer stacking: the scene composite sits over the workshop square preview, with an opaque fallback color at the bottom; the preview layer fills in during the first few seconds of scene extraction, the real image covers it when ready, and naturally falls back to the preview if the real image is unavailable) — a transparent root background makes Chromium disable subpixel anti-aliasing (ClearType) for the whole document; grayscale-rendered glyphs are the root cause of "wallpaper text looking blurry", and an opaque root background restores color subpixel rendering (end-to-end measurement: color ratio at text edges 56–60%, versus near 0 under grayscale rendering). **Video/web wallpapers still use a `position:fixed; z-index:-1` background layer under `body`** (`<video>`/`<iframe>` cannot serve as CSS backgrounds); text on top of them staying grayscale is an inherent Chromium constraint. **Popups (settings/Modal) are liquid glass and the wallpaper stays dynamic**: the wallpaper animation keeps running when a popup opens (the popup only floats above it); the panel is statically drawn liquid glass (82% translucent base + 160° specular gradient highlight + 1px bright edge + inner glow, one set per light/dark theme), with the mask lightened to 45%. **backdrop-filter is deliberately avoided**: in Chromium, any backdrop-filter element covering a video/iframe wallpaper freezes its animation frames (the official mask's own blur(2px) is among them); all are explicitly disabled, and the glass look is expressed through multiple static layers.
- **Local adaptive contrast inversion (dark-wallpaper readability)**: the client samples per-region brightness of the wallpaper (64×36 canvas, the left 22% as the sidebar region and the rest as the main region; video resamples every 2 seconds, while image/web wallpapers sample once from the preview image), and the sidebar region and main region are each judged independently: in light theme, if the wallpaper is dark (<0.38) → that region's text/icons flip to the official dark theme's ink color (near-white); in dark theme, if the wallpaper is bright (>0.62) → flip back to the light theme ink color; midtones keep the theme default. The scope only covers the two blocks that sit directly on the wallpaper — the sidebar (`[class*='sidebarCol']`) and the empty-state hero (`[class*='_composerHero']`), excluding the new-session button (which has its own white background); the input glass intensifies to 86% on conflict to keep dark text readable. In short, "dark wallpaper → white text, bright wallpaper → black text", automatically following the video's brightness changes.
- **Process stability (streams and subprocesses)**: every video/static-file streaming response attaches an error listener (`stream.on('error')` destroys the response, `res.on('close')` destroys the stream — the browser interrupts background video requests at any time when switching wallpapers or hiding tabs, and an unconsumed error event would kill the entire backend process); `startWallpaperEngine`'s detached spawn gets an error listener (an invalid exe path is an async 'error' event that would also crash the process); JSON/text responses never call writeHead twice after headers have been sent.
- **Three render modes** (auto-selected by wallpaper type): video wallpapers play the original video (`<video>`, 4K native quality); **web wallpapers load their html entry via iframe, so their own animations and particle effects run natively** (spine skeletal animation, canvas particles, etc.); **scene wallpapers = static base image + real-time particle animation**: the backend extracts and composites the particle-free layers from scene.pkg as the base image (`?flat=1`), and compiles the particle system into a pure data definition (`/scene-anim/<id>` JSON + `/scene-anim-tex/<id>/<idx>` texture atlases; scene-art.js: emitter/initializer/operator semantics, including 33-point curves for alpha/size/color and oscillation frequency ranges), and the frontend `#dshWpAnim` overlay (`z-index:-1`, pointer-events none) canvas simulates frame-by-frame — age progression/respawn, analytic ballistic integration (gravity/drag/vortex), angular-velocity integration matching the reference implementation semantics, independent X/Y-axis random oscillation, sprite-sheet frame animation, per-particle tint caching; **the canvas redraws the base image first each frame and then blends particles, with additive blending (`lighter`) applied directly onto real scene pixels** (a transparent overlay would make the black background of additive textures show through element-level compositing as black squares); cover transformation matches the body background, oversampled for dpr≤2; when the export is unavailable or base-image decoding fails it automatically falls back to a baked steady-state composite image (the texture chain supports RGBA/DXT1/3/5/RG88/R8/JPEG + LZ4 — roughly 1/4 of scene wallpapers have a JPEG-in-TEX main layer, rasterized by a built-in jpeg-js decoder (vendored, Apache-2.0) so layers are not dropped; shared particle textures fall back to the WE assets library; extraction runs in a worker thread, disk cache v5).
- Web wallpapers' static assets (html/js/css/images/fonts/embedded video) are streamed by the host side via `/plugin-wallpaper/web/<id>/<path>` (supports HTTP Range, resolves the path then prefix-validates against directory traversal, returns 404 for non-files).
- Control goes through Wallpaper Engine's official command-line interface (`wallpaper64.exe -control ...`); reading the current wallpaper goes through its `config.json` (measured in practice: the output of `-control getWallpaper` cannot be captured from an external process).
- Each wallpaper-list call scans the workshop directory in real time, so newly installed wallpapers need no restart.
- Applying a wallpaper uniformly passes the `project.json` path for scene/video/web types (supported by the official docs).