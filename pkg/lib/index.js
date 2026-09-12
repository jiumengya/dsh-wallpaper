/**
 * Model-facing Wallpaper Engine integration tools.
 * Provides 4 tools: `wallpaper_list`, `wallpaper_apply`, `wallpaper_control`,
 * `wallpaper_current`. Wallpaper Engine is discovered through Steam
 * (registry → libraryfolders.vdf → workshop content) and driven through its
 * documented `-control` command line interface.
 * @module @deepseek-ai/dsh-wallpaper
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import { createReadStream, promises as fsp } from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  findSteamLibraries,
  findSteamPath,
  findWallpaperEngineExe,
  isWallpaperEngineRunning,
  listWallpapers,
  readCurrentWallpapers,
  runControl,
  startWallpaperEngine,
} from './wallpaper-engine.js'

/**
 * Model-facing Wallpaper Engine integration tools plus the host half of the
 * settings-page data routes (same-origin `/plugin-wallpaper/*` endpoints the
 * browser section fetches).
 * @module @deepseek-ai/dsh-wallpaper
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wallpaper'

/** Services required by the wallpaper tool suite. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config. */
export const Config = z.object({
  steamPath: z.string().default(''),
  wallpaperEnginePath: z.string().default(''),
})

/** Maximum entries returned by wallpaper_list. */
const LIST_CAP = 500

/** Total tool-call timeout budget (ms). */
const TOOL_TIMEOUT_MS = 45_000

/**
 * Register the wallpaper tools. Steam/WE discovery results are cached per
 * process; the wallpaper list is re-scanned on every call so installs and
 * workshop updates are picked up without restarting the backend.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {{ steamPath?: string, wallpaperEnginePath?: string }} config Plugin config.
 */
export function apply(ctx, config) {
  let cachedSteamPath = null
  let cachedLibraries = null
  let cachedExe = undefined
  const localFiles = new Map()

  // Desktop-shell stability hooks. The shell pipes stdout/stderr into
  // backend.log through two reader threads whose concurrent AppendAllText
  // calls lose the losing writer to an IOException — exactly the situation
  // when an uncaught exception floods stderr while stdout is busy. These
  // hooks mirror every fatal error into an independent file before the
  // default exit behavior runs, so the cause survives even when the pipe
  // log does not.
  const crashSink = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugin-wallpaper-crash.log')
  const recordCrash = (kind, error) => {
    try {
      const detail = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
      fs.appendFileSync(crashSink, `[${new Date().toISOString()}] ${kind}: ${detail}\n`)
    } catch { /* the sink must never raise */ }
  }
  const onUncaught = (error) => { recordCrash('uncaughtException', error); process.exit(1) }
  const onRejection = (reason) => { recordCrash('unhandledRejection', reason); process.exit(1) }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  ctx.effect(() => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
  })

  async function steamRoot() {
    if (cachedSteamPath === null) cachedSteamPath = await findSteamPath(config.steamPath || '')
    return cachedSteamPath
  }

  async function libraries() {
    if (cachedLibraries === null) {
      const root = await steamRoot()
      cachedLibraries = root ? await findSteamLibraries(root) : []
    }
    return cachedLibraries
  }

  async function weExe() {
    if (cachedExe === undefined) {
      cachedExe = findWallpaperEngineExe(await libraries(), config.wallpaperEnginePath || '')
    }
    return cachedExe
  }

  /** Shared Wallpaper Engine asset library (`<install>/assets`), '' when absent. */
  async function weAssetsDir() {
    const exe = await weExe()
    if (!exe) return ''
    const dir = path.join(path.dirname(exe), 'assets')
    return fs.existsSync(dir) ? dir : ''
  }

  ctx.systemPrompt.section({
    name: 'tool:wallpaper',
    order: 130,
    text: [
      'You have Wallpaper Engine tools to manage the user\'s desktop wallpapers:',
      '- wallpaper_list: List installed Wallpaper Engine wallpapers; optionally filter with a query substring.',
      '- wallpaper_apply: Apply a wallpaper by workshop id or title (partial match), optionally on a specific monitor. Starts Wallpaper Engine if it is not running.',
      '- wallpaper_control: pause / play / stop / mute / unmute / next / close / hide_icons / show_icons.',
      '- wallpaper_current: Show the currently applied wallpaper.',
      'Wallpaper Engine must be installed via Steam. Use wallpaper_list before wallpaper_apply to find ids and titles.',
    ].join('\n'),
  })

  // ── wallpaper_list ────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'wallpaper_list',
    description: 'List installed Wallpaper Engine wallpapers with their workshop ids, titles and types. Optionally filter with a case-insensitive title substring.',
    parameters: {
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring to filter by title.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          matched: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          wallpapers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                type: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderList(value),
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args) {
      const root = await steamRoot()
      if (!root) throw new Error('Steam installation not found. Set steamPath in the tool-wallpaper config or install Steam.')
      const all = await listWallpapers(await libraries())
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim().toLowerCase() : ''
      const matched = query ? all.filter((w) => w.title.toLowerCase().includes(query)) : all
      const capped = matched.slice(0, LIST_CAP)
      return {
        total: all.length,
        matched: matched.length,
        truncated: matched.length > capped.length,
        wallpapers: capped.map((w) => ({ id: w.id, title: w.title, type: w.type })),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.query ? `Search wallpapers: ${args.query}` : 'List wallpapers',
      kind: 'search',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Wallpaper list failed' : 'Wallpaper list',
    }),
  }))

  // ── wallpaper_apply ───────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'wallpaper_apply',
    description: 'Apply a Wallpaper Engine wallpaper by workshop id or title (exact match preferred, unique partial match accepted), or by absolute path to the wallpaper\'s project.json. Optionally select a monitor (0-based index). Starts Wallpaper Engine if it is not running.',
    parameters: {
      wallpaper: {
        type: 'string',
        description: 'Workshop id or (partial) title of the wallpaper to apply.',
      },
      path: {
        type: 'string',
        description: 'Absolute path to a wallpaper\'s project.json (alternative to id/title lookup).',
      },
      monitor: {
        type: 'number',
        description: '0-based monitor index. Omit to use the first monitor.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          title: { type: 'string' },
          id: { type: 'string' },
          monitor: { type: 'number' },
          startedEngine: { type: 'boolean' },
          verified: { type: 'boolean' },
          appliedFile: { type: 'string' },
          error: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `Applied wallpaper "${value.title}"${value.monitor !== undefined ? ` on monitor ${value.monitor}` : ''}${value.startedEngine ? ' (started Wallpaper Engine)' : ''}${value.verified === false ? ' — could not confirm it is now active' : ''}.`
          : `Failed to apply wallpaper: ${value.error ?? 'unknown error'}`,
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args) {
      const exe = await weExe()
      if (!exe) {
        throw new Error('Wallpaper Engine executable not found. Install Wallpaper Engine via Steam or set wallpaperEnginePath in the tool-wallpaper config.')
      }
      const monitor = typeof args.monitor === 'number' ? args.monitor : null

      let projectJson
      let title = ''
      let id = ''
      if (typeof args.path === 'string' && args.path.trim()) {
        projectJson = args.path.trim()
        title = projectJson
      } else {
        const target = typeof args.wallpaper === 'string' ? args.wallpaper.trim() : ''
        if (!target) {
          return { success: false, error: 'Provide a wallpaper id, title or path.' }
        }
        const root = await steamRoot()
        if (!root) throw new Error('Steam installation not found. Set steamPath in the tool-wallpaper config or install Steam.')
        const matches = matchWallpaper(await listWallpapers(await libraries()), target)
        if (matches.length === 0) {
          return { success: false, error: `No installed wallpaper matches "${target}". Call wallpaper_list to see available wallpapers.` }
        }
        if (matches.length > 1) {
          return {
            success: false,
            error: `"${target}" is ambiguous (${matches.length} matches). Use the exact id or a more specific title.`,
            candidates: matches.slice(0, 10).map((w) => ({ id: w.id, title: w.title })),
          }
        }
        projectJson = matches[0].projectJson
        title = matches[0].title
        id = matches[0].id
      }

      let startedEngine = false
      if (!(await isWallpaperEngineRunning())) {
        startedEngine = true
        const started = await startWallpaperEngine(exe)
        if (!started) {
          return { success: false, error: 'Wallpaper Engine did not start within 20 seconds.', title, id }
        }
      }

      const controlArgs = ['openWallpaper', '-file', projectJson]
      if (monitor !== null) controlArgs.push('-monitor', String(monitor))
      const result = await runControl(exe, controlArgs)
      if (result.error) {
        return { success: false, error: result.error, title, id }
      }

      // config.json 反映当前选择(实测换壁纸后数秒内更新);回读确认应用结果。
      await delay(2_000)
      const monitors = await readCurrentWallpapers(exe)
      const key = monitor === null ? 'Monitor0' : `Monitor${monitor}`
      const appliedFile = monitors?.[key] ?? ''
      const verified = !!appliedFile && pathStartsWith(appliedFile, path.dirname(projectJson))

      const value = { success: true, title, id, startedEngine, verified, appliedFile }
      if (monitor !== null) value.monitor = monitor
      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Apply wallpaper ${args.wallpaper ?? args.path ?? ''}`,
      kind: 'execute',
      rawInput: { wallpaper: args.wallpaper, path: args.path, monitor: args.monitor },
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Apply failed' : 'Wallpaper applied',
    }),
  }))

  // ── wallpaper_control ─────────────────────────────────────────

  const CONTROL_ACTIONS = {
    pause: { args: ['pause'], needsEngine: true },
    play: { args: ['play'], needsEngine: true },
    stop: { args: ['stop'], needsEngine: true },
    mute: { args: ['mute'], needsEngine: true },
    unmute: { args: ['unmute'], needsEngine: true },
    next: { args: ['nextWallpaper'], monitor: true, needsEngine: true },
    close: { args: ['closeWallpaper'], monitor: true, needsEngine: true },
    hide_icons: { args: ['hideIcons'], needsEngine: true },
    show_icons: { args: ['showIcons'], needsEngine: true },
  }

  ctx.tools.register(defineTool({
    name: 'wallpaper_control',
    description: 'Control the running Wallpaper Engine: pause / play / stop / mute / unmute all wallpapers, skip to the next wallpaper, close wallpapers, or hide/show desktop icons.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: Object.keys(CONTROL_ACTIONS),
        description: 'Control action.',
      },
      monitor: {
        type: 'number',
        description: '0-based monitor index (only for next and close). Omit for all monitors.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `Wallpaper Engine: ${value.action} sent.`
          : `Failed to run "${value.action}": ${value.error ?? 'unknown error'}`,
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args) {
      const exe = await weExe()
      if (!exe) {
        throw new Error('Wallpaper Engine executable not found. Install Wallpaper Engine via Steam or set wallpaperEnginePath in the tool-wallpaper config.')
      }
      const action = String(args.action)
      const spec = CONTROL_ACTIONS[action]
      if (!spec) {
        return { success: false, action, error: `Unknown action. Valid: ${Object.keys(CONTROL_ACTIONS).join(', ')}` }
      }
      if (spec.needsEngine && !(await isWallpaperEngineRunning())) {
        return { success: false, action, error: 'Wallpaper Engine is not running. Use wallpaper_apply to apply a wallpaper (it starts the engine).' }
      }
      const controlArgs = [...spec.args]
      if (spec.monitor && typeof args.monitor === 'number') {
        controlArgs.push('-monitor', String(args.monitor))
      }
      const result = await runControl(exe, controlArgs)
      if (result.error) {
        return { success: false, action, error: result.error }
      }
      return { success: true, action }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Wallpaper Engine: ${args.action}`,
      kind: 'execute',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Control failed' : 'Command sent',
    }),
  }))

  // ── wallpaper_current ─────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'wallpaper_current',
    description: 'Show the currently applied Wallpaper Engine wallpaper (path and, when it matches an installed workshop item, its title).',
    parameters: {
      monitor: {
        type: 'number',
        description: '0-based monitor index. Omit to read the primary monitor.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean', required: true },
          wallpaper: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.running
          ? 'Wallpaper Engine is not running.'
          : value.title
            ? `Current wallpaper: ${value.title}\nPath: ${value.wallpaper}`
            : `Current wallpaper: ${value.wallpaper}`,
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args) {
      const exe = await weExe()
      if (!exe) {
        throw new Error('Wallpaper Engine executable not found. Install Wallpaper Engine via Steam or set wallpaperEnginePath in the tool-wallpaper config.')
      }
      if (!(await isWallpaperEngineRunning())) {
        return { running: false, wallpaper: '', title: '' }
      }
      const monitors = await readCurrentWallpapers(exe)
      if (!monitors) {
        return { running: true, wallpaper: '', title: '' }
      }
      const key = typeof args.monitor === 'number' ? `Monitor${args.monitor}` : 'Monitor0'
      const wallpaper = monitors[key] ?? Object.values(monitors)[0] ?? ''
      let title = ''
      if (wallpaper) {
        const root = await steamRoot()
        if (root) {
          const hit = (await listWallpapers(await libraries()))
            .find((w) => pathStartsWith(wallpaper, w.dir))
          if (hit) title = hit.title
        }
      }
      return { running: true, wallpaper, title }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Current wallpaper',
      kind: 'read',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Query failed' : 'Current wallpaper',
    }),
  }))

  // ── settings-page data routes (same-origin, the browser section fetches) ──

  ctx.inject(['webServer'], (webCtx) => {
    const routes = [
      { kind: 'exact', path: '/plugin-wallpaper/list', handler: handleList },
      { kind: 'exact', path: '/plugin-wallpaper/state', handler: handleState },
      { kind: 'exact', path: '/plugin-wallpaper/apply', handler: handleApply },
      { kind: 'exact', path: '/plugin-wallpaper/control', handler: handleControl },
      { kind: 'prefix', path: '/plugin-wallpaper/preview', handler: handlePreview },
      { kind: 'prefix', path: '/plugin-wallpaper/scene-art', handler: handleSceneArt },
      { kind: 'prefix', path: '/plugin-wallpaper/scene-anim-tex', handler: handleSceneAnimTex },
      { kind: 'prefix', path: '/plugin-wallpaper/scene-anim', handler: handleSceneAnim },
      { kind: 'prefix', path: '/plugin-wallpaper/scene-video', handler: handleSceneVideo },
      { kind: 'prefix', path: '/plugin-wallpaper/media', handler: handleMedia },
      { kind: 'prefix', path: '/plugin-wallpaper/local', handler: handleLocal },
      { kind: 'prefix', path: '/plugin-wallpaper/web', handler: handleWeb },
    ]
    for (const route of routes) {
      // The response stream carries wallpaper media that the browser aborts at
      // any moment (wallpaper switch, page reload, tab hide). pipe() forwards
      // source-stream errors only; an unlistened error on the destination
      // response would take the backend down, so every route consumes it.
      const dispose = webCtx.webServer.register({
        ...route,
        handler: (req, res) => {
          res.on('error', () => {})
          return route.handler(req, res)
        },
      })
      webCtx.effect(() => dispose)
    }
  })

  async function handleList(_req, res) {
    try {
      const root = await steamRoot()
      if (!root) return sendJson(res, 200, { running: false, wallpapers: [], current: null, total: 0, error: 'Steam installation not found.' })
      const [running, wallpapers, exe] = await Promise.all([
        weExe().then((e) => (e ? isWallpaperEngineRunning() : false)),
        listWallpapers(await libraries()),
        weExe(),
      ])
      let current = null
      if (running && exe) {
        const monitors = await readCurrentWallpapers(exe)
        const file = monitors?.Monitor0 ?? (monitors ? Object.values(monitors)[0] : '')
        if (file) {
          const hit = wallpapers.find((w) => pathStartsWith(file, w.dir))
          current = hit ? { id: hit.id, title: hit.title } : { id: '', title: file }
        }
      }
      sendJson(res, 200, {
        running,
        total: wallpapers.length,
        current,
        wallpapers: wallpapers.map((w) => ({
          id: w.id,
          title: w.title,
          type: w.type,
          preview: w.preview ? `/plugin-wallpaper/preview/${w.id}` : '',
        })),
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  async function handleApply(req, res) {
    try {
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const monitor = typeof body.monitor === 'number' && Number.isInteger(body.monitor) && body.monitor >= 0
        ? body.monitor
        : null
      if (!/^\d+$/.test(id)) return sendJson(res, 400, { ok: false, error: 'id must be a workshop id' })
      const exe = await weExe()
      if (!exe) return sendJson(res, 500, { ok: false, error: 'Wallpaper Engine executable not found.' })
      const hit = (await listWallpapers(await libraries())).find((w) => w.id === id)
      if (!hit) return sendJson(res, 404, { ok: false, error: `No installed wallpaper with id ${id}.` })

      let startedEngine = false
      if (!(await isWallpaperEngineRunning())) {
        startedEngine = true
        if (!(await startWallpaperEngine(exe))) {
          return sendJson(res, 500, { ok: false, error: 'Wallpaper Engine did not start within 20 seconds.' })
        }
      }
      const controlArgs = ['openWallpaper', '-file', hit.projectJson]
      if (monitor !== null) controlArgs.push('-monitor', String(monitor))
      const result = await runControl(exe, controlArgs)
      if (result.error) return sendJson(res, 500, { ok: false, error: result.error })

      await delay(2_000)
      const monitors = await readCurrentWallpapers(exe)
      const key = monitor === null ? 'Monitor0' : `Monitor${monitor}`
      const appliedFile = monitors?.[key] ?? ''
      const verified = !!appliedFile && pathStartsWith(appliedFile, hit.dir)
      sendJson(res, 200, { ok: true, title: hit.title, id: hit.id, verified })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  async function handleControl(req, res) {
    try {
      const body = await readJsonBody(req)
      const action = typeof body.action === 'string' ? body.action : ''
      const monitor = typeof body.monitor === 'number' && Number.isInteger(body.monitor) && body.monitor >= 0
        ? body.monitor
        : null
      const spec = HTTP_CONTROL_ACTIONS[action]
      if (!spec) return sendJson(res, 400, { ok: false, error: `Unknown action. Valid: ${Object.keys(HTTP_CONTROL_ACTIONS).join(', ')}` })
      const exe = await weExe()
      if (!exe) return sendJson(res, 500, { ok: false, error: 'Wallpaper Engine executable not found.' })
      if (!(await isWallpaperEngineRunning())) {
        return sendJson(res, 409, { ok: false, error: 'Wallpaper Engine is not running.' })
      }
      const controlArgs = [...spec]
      if (monitor !== null) controlArgs.push('-monitor', String(monitor))
      const result = await runControl(exe, controlArgs)
      if (result.error) return sendJson(res, 500, { ok: false, error: result.error })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  async function handlePreview(req, res) {
    try {
      const parts = (req.url ?? '').split('/').filter(Boolean)
      const id = parts[2] ?? ''
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      const root = await steamRoot()
      if (!root) return sendText(res, 404, 'steam not found')
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        try {
          const meta = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'))
          const rel = typeof meta.preview === 'string' ? meta.preview.trim() : ''
          if (!rel || rel.includes('..')) continue
          const file = path.join(dir, rel)
          const data = await fsp.readFile(file)
          res.writeHead(200, { 'content-type': contentTypeOf(file), 'cache-control': 'no-store' })
          res.end(data)
          return
        } catch (error) {
          if (error && error.code === 'ENOENT') continue
          throw error
        }
      }
      sendText(res, 404, 'no preview')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /** In-memory scene-art cache: workshop id → `{ data, contentType, anim, flat, stamp }`. */
  const sceneArtMem = new Map()

  /** In-memory animation cache: workshop id → `{ anim, stamp }` (anim may be null). */
  const sceneAnimMem = new Map()

  /**
   * Extract scene art in a worker thread: decoding a large DXT/LZ4 texture is
   * CPU-bound for seconds and must not stall the backend event loop.
   * @param {string} pkgPath Absolute path to scene.pkg.
   * @param {string} weAssetsDir Wallpaper Engine assets directory; particle
   *   materials may reference shared textures that live only there.
   * @returns {Promise<{ data: Buffer, contentType: string, anim: object | null, flat: Buffer | null,
   *   videos: { w: number, h: number, videos: { M: number[], w: number, h: number, opacity: number, key: object | null, blend: number, mp4: Buffer }[] } | null }>}
   */
  function extractInWorker(pkgPath, weAssetsDir) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./scene-art-worker.js', import.meta.url))
      worker.on('message', (msg) => {
        void worker.terminate()
        if (msg?.error) {
          reject(new Error(msg.error))
        } else {
          const data = Buffer.isBuffer(msg.data)
            ? msg.data
            : Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)
          const flat = Buffer.isBuffer(msg.flat)
            ? msg.flat
            : msg.flat
              ? Buffer.from(msg.flat.buffer, msg.flat.byteOffset, msg.flat.byteLength)
              : null
          const textures = []
          for (const t of msg.anim?.textures ?? []) {
            textures.push({
              png: Buffer.isBuffer(t.png) ? t.png : Buffer.from(t.png.buffer, t.png.byteOffset, t.png.byteLength),
              frames: t.frames ?? null,
              blending: t.blending ?? 'translucent',
            })
          }
          const anim = msg.anim ? { w: msg.anim.w, h: msg.anim.h, systems: msg.anim.systems, textures } : null
          const toBuffer = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength))
          const videos = msg.videos
            ? {
              w: msg.videos.w,
              h: msg.videos.h,
              videos: msg.videos.videos.map((v) => ({
                M: v.M, w: v.w, h: v.h, opacity: v.opacity, key: v.key ?? null, blend: v.blend ?? 0, mp4: toBuffer(v.mp4),
              })),
            }
            : null
          resolve({ data, contentType: msg.contentType, anim, flat, videos })
        }
      })
      worker.on('error', (error) => {
        void worker.terminate()
        reject(error)
      })
      worker.postMessage({ pkgPath, weAssetsDir })
    })
  }

  /** On-disk cache directory for scene art and particle-animation exports. */
  function sceneCacheDir() {
    return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugin-wallpaper-scene')
  }

  /**
   * Load the particle-animation export from disk. Layout: `<id>.anim.json`
   * (stamp + systems + texture metadata) plus `<id>.anim-tex-<i>.png` per
   * texture atlas.
   * @param {string} cacheDir Cache directory.
   * @param {string} id Workshop id.
   * @param {string} stamp Required scene.pkg stamp.
   * @returns {Promise<object | null>} Anim export, or null on mismatch/absence.
   */
  async function loadAnimFromDisk(cacheDir, id, stamp) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(cacheDir, `${id}.anim.json`), 'utf8'))
      // v2: systems carry instanceoverride-applied parameters plus starttime;
      // v1 exports paint authored (unoverridden) sizes and never delay.
      if (meta?.v !== 2 || meta?.stamp !== stamp || !Array.isArray(meta?.systems) || !Array.isArray(meta?.textures)) return null
      const textures = []
      for (const t of meta.textures) {
        const png = await fsp.readFile(path.join(cacheDir, `${id}.anim-tex-${textures.length}.png`))
        textures.push({ png, frames: t.frames ?? null, blending: t.blending ?? 'translucent' })
      }
      return { w: meta.w, h: meta.h, systems: meta.systems, textures }
    } catch {
      return null
    }
  }

  /** Persist one animation export next to the art cache (best-effort). */
  async function saveAnimToDisk(cacheDir, id, stamp, anim) {
    await fsp.mkdir(cacheDir, { recursive: true })
    const meta = {
      v: 2, stamp, w: anim.w, h: anim.h, systems: anim.systems,
      textures: anim.textures.map((t) => ({ frames: t.frames, blending: t.blending })),
    }
    await fsp.writeFile(path.join(cacheDir, `${id}.anim.json`), JSON.stringify(meta))
    for (let i = 0; i < anim.textures.length; i++) {
      await fsp.writeFile(path.join(cacheDir, `${id}.anim-tex-${i}.png`), anim.textures[i].png)
    }
  }

  /**
   * Ensure the particle-animation export for one wallpaper is available:
   * memory → the art cache entry → disk → one worker re-extraction (the disk
   * art cache predates the animation export, so the first request after an
   * upgrade re-runs the extraction off-thread and caches the result). A null
   * result is cached per stamp too, so impossible wallpapers don't re-extract.
   * @param {string} id Workshop id.
   * @param {string} dir Wallpaper directory containing scene.pkg.
   * @returns {Promise<object | null>} Anim export, or null when the wallpaper
   *   has no scene.pkg or no usable particle systems.
   */
  async function ensureSceneAnim(id, dir) {
    const pkgPath = path.join(dir, 'scene.pkg')
    const stat = await fsp.stat(pkgPath).catch(() => null)
    if (!stat || stat.size === 0) return null
    const stamp = `${Math.round(stat.mtimeMs)}-${stat.size}`
    const cached = sceneAnimMem.get(id)
    if (cached && cached.stamp === stamp) return cached.anim
    const art = sceneArtMem.get(id)
    let anim = art && art.stamp === stamp ? art.anim ?? null : null
    if (!anim) anim = await loadAnimFromDisk(sceneCacheDir(), id, stamp)
    if (!anim) {
      const fresh = await extractInWorker(pkgPath, await weAssetsDir()).catch(() => null)
      anim = fresh?.anim ?? null
      if (anim) await saveAnimToDisk(sceneCacheDir(), id, stamp, anim).catch(() => {})
    }
    sceneAnimMem.set(id, { anim, stamp })
    return anim
  }

  /**
   * Extract (or serve cached) the background art of one scene wallpaper.
   * Results are cached in memory and on disk, keyed by the scene.pkg
   * mtime+size stamp so workshop updates invalidate them.
   * @param {string} id Workshop id.
   * @param {string} dir Wallpaper directory containing scene.pkg.
   * @returns {Promise<{ data: Buffer, contentType: string, anim: object | null, flat: Buffer | null, stamp: string } | null>} Null when
   *   the wallpaper has no scene.pkg or extraction failed.
   */
  async function sceneArtFor(id, dir) {
    const pkgPath = path.join(dir, 'scene.pkg')
    const stat = await fsp.stat(pkgPath).catch(() => null)
    if (!stat || stat.size === 0) return null
    const stamp = `${Math.round(stat.mtimeMs)}-${stat.size}`
    const mem = sceneArtMem.get(id)
    if (mem && mem.stamp === stamp) return mem
    const cacheDir = sceneCacheDir()
    const metaPath = path.join(cacheDir, `${id}.json`)
    // v9: video entries carry colorBlendMode (31 = linear add renders the
    // rope glow; without it the live overlay paints black-bodied videos as
    // opaque source-over rectangles). v8 entries lack the field; they must
    // regenerate. v7 baked the videos as RGB noise and ghosted the hidden
    // Media Info UI.
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
      if (meta?.v === 9 && typeof meta?.stamp === 'string' && meta.stamp === stamp && typeof meta.file === 'string' && /^\d+\.(png|jpg)$/.test(meta.file)) {
        const data = await fsp.readFile(path.join(cacheDir, meta.file))
        let flat = null
        if (typeof meta.flat === 'string') flat = await fsp.readFile(path.join(cacheDir, meta.flat)).catch(() => null)
        const anim = await loadAnimFromDisk(cacheDir, id, stamp)
        if (anim) sceneAnimMem.set(id, { anim, stamp })
        const videos = meta.videos && Array.isArray(meta.videos.entries)
          ? { w: meta.videos.w, h: meta.videos.h, videos: meta.videos.entries }
          : null
        const value = { data, contentType: meta.contentType, anim, flat, videos, stamp }
        sceneArtMem.set(id, value)
        return value
      }
    } catch { /* cache miss */ }
    const art = await extractInWorker(pkgPath, await weAssetsDir())
    const file = `${id}.${art.contentType === 'image/png' ? 'png' : 'jpg'}`
    const flatFile = art.flat ? `${id}.flat.png` : ''
    await fsp.mkdir(cacheDir, { recursive: true })
    await fsp.writeFile(path.join(cacheDir, file), art.data)
    if (art.flat) await fsp.writeFile(path.join(cacheDir, flatFile), art.flat)
    const videoMeta = art.videos
      ? {
        w: art.videos.w,
        h: art.videos.h,
        entries: art.videos.videos.map((v) => ({ M: v.M, w: v.w, h: v.h, opacity: v.opacity, key: v.key, blend: v.blend ?? 0 })),
      }
      : undefined
    if (art.videos) {
      for (let i = 0; i < art.videos.videos.length; i++) {
        await fsp.writeFile(path.join(cacheDir, `${id}.video-${i}.mp4`), art.videos.videos[i].mp4)
      }
    }
    await fsp.writeFile(metaPath, JSON.stringify({ v: 9, stamp, contentType: art.contentType, file, flat: flatFile || undefined, videos: videoMeta }))
    if (art.anim) {
      await saveAnimToDisk(cacheDir, id, stamp, art.anim).catch(() => {})
      sceneAnimMem.set(id, { anim: art.anim, stamp })
    }
    const videos = art.videos
      ? { w: art.videos.w, h: art.videos.h, videos: art.videos.videos.map((v) => ({ M: v.M, w: v.w, h: v.h, opacity: v.opacity, key: v.key, blend: v.blend ?? 0 })) }
      : null
    const value = { data: art.data, contentType: art.contentType, anim: art.anim, flat: art.flat, videos, stamp }
    sceneArtMem.set(id, value)
    return value
  }

  /**
   * Serve the background art of one scene wallpaper. Falls back to the square
   * preview when the wallpaper is unknown or extraction is impossible, so the
   * client's `<img>` never breaks. `?flat=1` serves the art frame without the
   * baked steady-state particles (for the browser's live particle overlay);
   * it falls back to the composite when no flat frame exists.
   */
  async function handleSceneArt(req, res) {
    try {
      const [pathPart, queryPart = ''] = (req.url ?? '').split('?')
      const parts = pathPart.split('/').filter(Boolean)
      const id = parts[2] ?? ''
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      const flat = new URLSearchParams(queryPart).get('flat') === '1'
      let art = null
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        art = await sceneArtFor(id, dir).catch(() => null)
        if (art) break
      }
      if (art) {
        const useFlat = flat && !!art.flat
        // no-store: the same URL's payload semantics change across plugin
        // versions (the `flat` variant, cache regenerations), and a stale 200
        // with an undecodable body makes the CSS art layer fail silently over
        // the poster layer. The on-disk scene cache already serves repeats.
        res.writeHead(200, { 'content-type': useFlat ? 'image/png' : art.contentType, 'cache-control': 'private, no-store' })
        res.end(useFlat ? art.flat : art.data)
        return
      }
      await handlePreview(req, res)
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /**
   * Serve the particle-animation export of one scene wallpaper: projection
   * size, per-system local→projection matrix + plain-data particle spec, and
   * texture-atlas metadata (PNG bytes come from `/scene-anim-tex/<id>/<idx>`).
   * 404 when the wallpaper has no usable particle systems.
   */
  async function handleSceneAnim(req, res) {
    try {
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      const id = parts[2] ?? ''
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        const anim = await ensureSceneAnim(id, dir).catch(() => null)
        if (anim) {
          const payload = {
            w: anim.w,
            h: anim.h,
            systems: anim.systems,
            textures: anim.textures.map((t) => ({ frames: t.frames, blending: t.blending })),
          }
          // no-store: the export format follows the plugin version; a stale
          // cached definition would render against mismatched textures.
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' })
          res.end(JSON.stringify(payload))
          return
        }
      }
      sendText(res, 404, 'no particle animation')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /** Serve one texture-atlas PNG of a wallpaper's animation export. */
  async function handleSceneAnimTex(req, res) {
    try {
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      const id = parts[2] ?? ''
      const idx = Number(parts[3] ?? '')
      if (!/^\d+$/.test(id) || !Number.isInteger(idx) || idx < 0) return sendText(res, 400, 'bad id')
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        const anim = await ensureSceneAnim(id, dir).catch(() => null)
        if (anim && anim.textures[idx]) {
          // no-store: texture bytes regenerate with the animation export; a
          // stale 200 body would decode the atlas as garbage petals.
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' })
          res.end(anim.textures[idx].png)
          return
        }
      }
      sendText(res, 404, 'no texture')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /**
   * Serve the MP4 video-layer export of one scene wallpaper. Bare
   * `/scene-video/<id>` answers the layer metadata JSON (projection size plus
   * per-layer matrix, quad size, opacity, colorkey and colorBlendMode);
   * `/scene-video/<id>/<i>` streams layer `<i>`'s MP4 bytes from the scene
   * cache. 404 when the wallpaper has no MP4 video layers.
   */
  async function handleSceneVideo(req, res) {
    try {
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      const id = parts[2] ?? ''
      const idxPart = String(parts[3] ?? '').replace(/\.mp4$/i, '')
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        const art = await sceneArtFor(id, dir).catch(() => null)
        if (!art?.videos) continue
        if (idxPart === '') {
          // no-store: the export format follows the plugin version; a stale
          // cached definition would composite videos against a wrong matrix.
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' })
          res.end(JSON.stringify({
            w: art.videos.w,
            h: art.videos.h,
            videos: art.videos.videos.map((v) => ({ M: v.M, w: v.w, h: v.h, opacity: v.opacity, key: v.key, blend: v.blend ?? 0 })),
          }))
          return
        }
        const idx = Number(idxPart)
        if (!Number.isInteger(idx) || idx < 0 || idx >= art.videos.videos.length) return sendText(res, 400, 'bad video index')
        const mp4 = await fsp.readFile(path.join(sceneCacheDir(), `${id}.video-${idx}.mp4`)).catch(() => null)
        if (mp4) {
          // no-store: the bytes re-extract when the workshop item updates
          // under the same id, so a cached copy could be stale.
          res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'private, no-store' })
          res.end(mp4)
          return
        }
      }
      sendText(res, 404, 'no scene video')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /** Resolve the persisted app-background selection into a render instruction. */
  async function resolveUiState() {
    const empty = { id: '', title: '', type: '', mode: '', src: '', poster: '', source: '' }
    const selection = await readUiState()
    if (!selection.kind) return empty
    if (selection.kind === 'local') {
      const local = await inspectLocalFile(selection.path)
      if (!local) {
        await writeUiState({ kind: 'none' })
        return empty
      }
      const token = tokenForLocal(local.path)
      localFiles.set(token, local.path)
      return {
        id: `local:${token}`,
        title: local.name,
        type: local.type,
        mode: local.type === 'video' ? 'video' : 'image',
        src: `/plugin-wallpaper/local/${token}`,
        poster: '',
        source: 'local',
      }
    }
    const id = selection.id
    if (!id) return empty
    const hit = (await listWallpapers(await libraries())).find((w) => w.id === id)
    if (!hit) {
      await writeUiState({ kind: 'none' })
      return empty
    }
    const poster = hit.preview ? `/plugin-wallpaper/preview/${hit.id}` : ''
    if (hit.type === 'video' && hit.file && !isExternalUrl(hit.file)) {
      return { id: hit.id, title: hit.title, type: hit.type, mode: 'video', src: `/plugin-wallpaper/media/${hit.id}`, poster, source: 'workshop' }
    }
    if ((hit.type === 'web' || hit.type === 'application') && hit.file) {
      const src = isExternalUrl(hit.file)
        ? hit.file
        : `/plugin-wallpaper/web/${hit.id}/${encodePath(hit.file)}`
      return { id: hit.id, title: hit.title, type: hit.type, mode: 'frame', src, poster, source: 'workshop' }
    }
    // Scene wallpapers render their real background art (extracted from
    // scene.pkg) instead of the square workshop preview; image wallpapers
    // serve their original image file. Both fall back to the preview in
    // `handleSceneArt` / on the client when the asset is unusable.
    if (hit.type === 'scene') {
      return { id: hit.id, title: hit.title, type: hit.type, mode: 'image', src: `/plugin-wallpaper/scene-art/${hit.id}`, poster, source: 'workshop' }
    }
    if (hit.type === 'image' && hit.file && !isExternalUrl(hit.file) && !hit.file.includes('..')) {
      return { id: hit.id, title: hit.title, type: hit.type, mode: 'image', src: `/plugin-wallpaper/web/${hit.id}/${encodePath(hit.file)}`, poster, source: 'workshop' }
    }
    return { id: hit.id, title: hit.title, type: hit.type, mode: 'image', src: poster, poster: '', source: 'workshop' }
  }

  /** GET/POST the app-background selection; accepts workshop ids and picker-backed local files. */
  async function handleState(req, res) {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body?.selection?.kind === 'local') {
          const local = await inspectLocalFile(body.selection.path)
          if (!local) return sendJson(res, 400, { error: '请选择受支持的图片或视频文件。' })
          await writeUiState({ kind: 'local', path: local.path })
        } else {
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (id !== '') {
            if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: 'id must be a workshop id' })
            const hit = (await listWallpapers(await libraries())).find((w) => w.id === id)
            if (!hit) return sendJson(res, 404, { error: `No installed wallpaper with id ${id}.` })
            await writeUiState({ kind: 'workshop', id })
          } else {
            await writeUiState({ kind: 'none' })
          }
        }
      }
      sendJson(res, 200, await resolveUiState())
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /** Serve the currently selected local file through an opaque in-memory token. */
  async function handleLocal(req, res) {
    const token = (req.url ?? '').split('?')[0].split('/').filter(Boolean)[2] ?? ''
    const file = localFiles.get(token)
    if (!file || token !== tokenForLocal(file)) return sendText(res, 404, 'no local media')
    const local = await inspectLocalFile(file)
    if (!local) return sendText(res, 404, 'local media is unavailable')
    const served = await tryStreamFile(req, res, local.path)
    if (!served) sendText(res, 404, 'local media is unavailable')
  }

  /** Serve the background media for one wallpaper: the original video file for video wallpapers, otherwise the preview image. */
  async function handleMedia(req, res) {
    try {
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
      const id = parts[2] ?? ''
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      const root = await steamRoot()
      if (!root) return sendText(res, 404, 'steam not found')
      for (const library of await libraries()) {
        const dir = path.join(library, 'steamapps', 'workshop', 'content', '431960', id)
        let meta
        try {
          meta = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'))
        } catch (error) {
          if (error && error.code === 'ENOENT') continue
          throw error
        }
        const dirAbs = path.resolve(dir)
        const file = typeof meta.file === 'string' ? meta.file.trim() : ''
        if (meta.type === 'video' && file && !/^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.includes('..')) {
          const videoPath = path.resolve(dir, file)
          if (videoPath.toLowerCase().startsWith(dirAbs.toLowerCase() + path.sep.toLowerCase())) {
            const served = await tryStreamFile(req, res, videoPath)
            if (served) return
          }
        }
        const rel = typeof meta.preview === 'string' ? meta.preview.trim() : ''
        if (!rel || rel.includes('..')) continue
        const file2 = path.join(dir, rel)
        try {
          const data = await fsp.readFile(file2)
          res.writeHead(200, { 'content-type': contentTypeOf(file2), 'cache-control': 'no-store' })
          res.end(data)
          return
        } catch (error) {
          if (error && error.code === 'ENOENT') continue
          throw error
        }
      }
      sendText(res, 404, 'no media')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }

  /** Serve any file inside one wallpaper's workshop directory (web wallpapers load their html entry and assets). */
  async function handleWeb(req, res) {
    try {
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
      const id = parts[2] ?? ''
      const fileRel = parts.slice(3).join('/')
      if (!/^\d+$/.test(id)) return sendText(res, 400, 'bad id')
      if (!fileRel) return sendText(res, 400, 'bad path')
      const root = await steamRoot()
      if (!root) return sendText(res, 404, 'steam not found')
      for (const library of await libraries()) {
        const dir = path.resolve(path.join(library, 'steamapps', 'workshop', 'content', '431960', id))
        try {
          await fsp.access(path.join(dir, 'project.json'))
        } catch {
          continue
        }
        const file = path.resolve(dir, fileRel)
        if (!file.toLowerCase().startsWith(dir.toLowerCase() + path.sep.toLowerCase())) {
          return sendText(res, 403, 'forbidden')
        }
        const served = await tryStreamFile(req, res, file)
        if (served) return
      }
      sendText(res, 404, 'no file')
    } catch (error) {
      sendText(res, 500, String(error?.message ?? error))
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────

/** Settings-page control actions → `-control` argument lists. */
const HTTP_CONTROL_ACTIONS = {
  pause: ['pause'],
  play: ['play'],
  stop: ['stop'],
  mute: ['mute'],
  unmute: ['unmute'],
  next: ['nextWallpaper'],
  close: ['closeWallpaper'],
  hide_icons: ['hideIcons'],
  show_icons: ['showIcons'],
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Case-insensitive path-prefix comparison tolerant of slash direction:
 * Wallpaper Engine config paths use forward slashes, workshop dirs use
 * path.join backslashes.
 */
function pathStartsWith(file, dir) {
  const normalizedFile = path.normalize(file).replace(/\//g, '\\').toLowerCase()
  const normalizedDir = path.normalize(dir).replace(/\//g, '\\').toLowerCase()
  return normalizedFile.startsWith(normalizedDir)
}

/** Match wallpapers by workshop id, exact title, then partial title. */
function matchWallpaper(list, target) {
  if (/^\d+$/.test(target)) {
    const byId = list.filter((w) => w.id === target)
    if (byId.length > 0) return byId
  }
  const lower = target.toLowerCase()
  const exact = list.filter((w) => w.title.toLowerCase() === lower)
  if (exact.length > 0) return exact
  return list.filter((w) => w.title.toLowerCase().includes(lower))
}

/** Compact multi-line listing for the model. */
function renderList(value) {
  const lines = [`Installed wallpapers: ${value.matched} matched of ${value.total} total.`]
  const shown = value.wallpapers.slice(0, 100)
  for (const w of shown) {
    lines.push(`- [${w.id}] (${w.type || 'unknown'}) ${w.title}`)
  }
  if (value.wallpapers.length > shown.length) {
    lines.push(`... and ${value.wallpapers.length - shown.length} more (use query to filter).`)
  }
  if (value.truncated) {
    lines.push(`List truncated at ${LIST_CAP}; use query to narrow down.`)
  }
  return lines.join('\n')
}

/** Read and parse a JSON request body; rejects on malformed input or client abort. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('aborted', () => reject(new Error('request aborted')))
    req.on('error', reject)
  })
}

/** Send a JSON response; a no-op when headers were already sent (streaming routes). */
function sendJson(res, status, value) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Send a plain-text response; a no-op when headers were already sent (streaming routes). */
function sendText(res, status, text) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** Content type by preview file extension. */
function contentTypeOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

/** Persisted app-background state lives in the dsh home so it survives app updates. */
function uiStatePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-wallpaper-ui.json')
}

/** Read versioned background selection, migrating the legacy `{ id }` format. */
async function readUiState() {
  try {
    const raw = (await fsp.readFile(uiStatePath(), 'utf8')).replace(/^\uFEFF/, '')
    const value = JSON.parse(raw)
    if (value?.version === 1 && value.selection?.kind === 'local' && typeof value.selection.path === 'string') return { kind: 'local', path: value.selection.path }
    if (value?.version === 1 && value.selection?.kind === 'workshop' && typeof value.selection.id === 'string') return { kind: 'workshop', id: value.selection.id.trim() }
    if (value?.version === 1 && value.selection?.kind === 'none') return { kind: 'none' }
    if (typeof value?.id === 'string' && value.id.trim()) return { kind: 'workshop', id: value.id.trim() }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}

/** Persist the app-background selection. */
async function writeUiState(selection) {
  await fsp.mkdir(path.dirname(uiStatePath()), { recursive: true })
  await fsp.writeFile(uiStatePath(), `${JSON.stringify({ version: 1, selection }, null, 2)}\n`, 'utf8')
}

const LOCAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const LOCAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])
const LOCAL_MAX_BYTES = 1024 * 1024 * 1024

/** Validate a user-selected local image or video before use. */
async function inspectLocalFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null
  const absolute = path.resolve(value)
  const ext = path.extname(absolute).toLowerCase()
  const type = LOCAL_IMAGE_EXTENSIONS.has(ext) ? 'image' : LOCAL_VIDEO_EXTENSIONS.has(ext) ? 'video' : ''
  if (!type) return null
  try {
    const link = await fsp.lstat(absolute)
    if (link.isSymbolicLink() || !link.isFile() || link.size > LOCAL_MAX_BYTES) return null
    const stat = await fsp.stat(absolute)
    if (!stat.isFile() || stat.size > LOCAL_MAX_BYTES) return null
    return { path: absolute, name: path.basename(absolute), type }
  } catch {
    return null
  }
}

/** Derive a non-path token for the currently selected local file. */
function tokenForLocal(file) {
  return crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32)
}

/**
 * Stream a file with HTTP range support; resolves false when the file is
 * missing so the caller can fall back. Stream and response errors are always
 * consumed: the browser aborts background-video requests whenever wallpapers
 * switch or tabs hide, and an unread error on either side would take the whole
 * backend process down.
 */
async function tryStreamFile(req, res, file) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  const headers = {
    'content-type': staticTypeOf(file),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  }
  const range = typeof req.headers.range === 'string' ? req.headers.range : ''
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  let stream
  if (match && (match[1] !== '' || match[2] !== '')) {
    const start = match[1] === '' ? Math.max(0, stat.size - Number(match[2])) : Number(match[1])
    const end = match[2] === '' ? stat.size - 1 : Math.min(stat.size - 1, Number(match[2]))
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
      res.end()
      return true
    }
    res.writeHead(206, {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${stat.size}`,
    })
    stream = createReadStream(file, { start, end })
  } else {
    res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
    stream = createReadStream(file)
  }
  stream.on('error', () => { res.destroy() })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
  return true
}

/** Content type by file extension for wallpaper assets (web entries, videos, images, fonts). */
function staticTypeOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.ogg') return 'audio/ogg'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.ttf') return 'font/ttf'
  if (ext === '.otf') return 'font/otf'
  return 'application/octet-stream'
}

/** Whether a project.json `file` value is an absolute URL rather than a local path. */
function isExternalUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

/** URL-encode each path segment of a relative file path for a same-origin URL. */
function encodePath(value) {
  return value.split(/[\\/]/).filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
}
