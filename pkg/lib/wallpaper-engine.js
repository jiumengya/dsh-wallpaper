/**
 * Wallpaper Engine discovery and control primitives.
 * Zero npm dependencies — Steam is found via the registry, libraries via
 * libraryfolders.vdf, wallpapers via workshop content scanning, and control
 * goes through the wallpaper32/64.exe `-control` command line interface.
 * @module wallpaper-engine
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Steam Workshop app id for Wallpaper Engine. */
const WE_APP_ID = '431960'

/** Controller process exit timeout (ms). */
const CONTROL_TIMEOUT_MS = 8_000

/** How long to wait for Wallpaper Engine to come up after launching it (ms). */
const STARTUP_TIMEOUT_MS = 20_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run a command and capture its stdout.
 * @param {string} file Executable to run.
 * @param {string[]} args Command arguments.
 * @param {number} [timeoutMs] Kill after this long without exiting.
 * @returns {Promise<{ code: number | null, stdout: string, error?: string }>}
 */
function execCapture(file, args, timeoutMs = CONTROL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    let child
    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      finish({ code: null, stdout: '', error: String(error) })
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ code: null, stdout, error: 'timeout' })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: null, stdout, error: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      finish({ code, stdout })
    })
  })
}

/**
 * Locate the Steam installation root.
 * @param {string} explicit Config override; returned as-is when set.
 * @returns {Promise<string | null>} Steam root path, or null when not found.
 */
export async function findSteamPath(explicit) {
  if (explicit) return explicit
  const reg = await execCapture(
    'reg',
    ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
  )
  const match = reg.code === 0
    ? reg.stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    : null
  if (match) return match[1].trim()
  for (const candidate of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Enumerate Steam library roots from libraryfolders.vdf (config/ and legacy
 * steamapps/ locations), always including the Steam root itself.
 * @param {string} steamPath Steam installation root.
 * @returns {Promise<string[]>} Existing library roots.
 */
export async function findSteamLibraries(steamPath) {
  const libraries = new Set()
  for (const vdf of [
    path.join(steamPath, 'config', 'libraryfolders.vdf'),
    path.join(steamPath, 'steamapps', 'libraryfolders.vdf'),
  ]) {
    let text
    try {
      text = await fsp.readFile(vdf, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    for (const match of text.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) {
      libraries.add(match[1].replace(/\\\\/g, '\\'))
    }
  }
  libraries.add(path.normalize(steamPath))
  const seen = new Set()
  const result = []
  for (const library of libraries) {
    const normalized = path.normalize(library)
    const key = normalized.toLowerCase()
    if (seen.has(key) || !existsSync(normalized)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

/**
 * Locate the Wallpaper Engine controller executable.
 * Prefers wallpaper64.exe; falls back to wallpaper32.exe.
 * @param {string[]} libraries Steam library roots.
 * @param {string} explicit Config override; used when the file exists.
 * @returns {string | null} Absolute path to the executable.
 */
export function findWallpaperEngineExe(libraries, explicit) {
  if (explicit && existsSync(explicit)) return explicit
  for (const library of libraries) {
    const dir = path.join(library, 'steamapps', 'common', 'wallpaper_engine')
    for (const exe of ['wallpaper64.exe', 'wallpaper32.exe']) {
      const candidate = path.join(dir, exe)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Scan workshop content for installed wallpapers.
 * A workshop item counts as a wallpaper when its directory contains a
 * parseable project.json.
 * @param {string[]} libraries Steam library roots.
 * @returns {Promise<WallpaperEntry[]>} Entries sorted by title.
 */
export async function listWallpapers(libraries) {
  const entries = []
  for (const library of libraries) {
    const root = path.join(library, 'steamapps', 'workshop', 'content', WE_APP_ID)
    let items
    try {
      items = await fsp.readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    for (const item of items) {
      if (!item.isDirectory()) continue
      const projectJson = path.join(root, item.name, 'project.json')
      let meta
      try {
        meta = JSON.parse(await fsp.readFile(projectJson, 'utf8'))
      } catch {
        continue
      }
      const dir = path.join(root, item.name)
      const preview = typeof meta.preview === 'string' && meta.preview.trim()
        ? path.join(dir, meta.preview.trim())
        : ''
      entries.push({
        id: item.name,
        title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : item.name,
        // project.json capitalizes freely ("Scene" vs "scene"); normalize so
        // type dispatch compares lowercase everywhere.
        type: typeof meta.type === 'string' ? meta.type.toLowerCase() : '',
        tags: normalizeTags(meta.tags),
        dir,
        projectJson,
        file: typeof meta.file === 'string' ? meta.file.trim() : '',
        preview,
      })
    }
  }
  entries.sort((a, b) => a.title.localeCompare(b.title))
  return entries
}

/**
 * @typedef {Object} WallpaperEntry
 * @property {string} id Workshop item id.
 * @property {string} title Display title.
 * @property {string} type Wallpaper type (scene / video / web / application).
 * @property {string[]} tags Tag names.
 * @property {string} dir Absolute workshop directory.
 * @property {string} projectJson Absolute project.json path.
 * @property {string} file project.json `file` value: scene.json / video file / html entry ('' when absent).
 * @property {string} preview Absolute preview image path ('' when absent).
 */

/** project.json tags are either plain strings or { name } objects. */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return tags
    .map((tag) => {
      if (typeof tag === 'string') return tag
      if (tag && typeof tag.name === 'string') return tag.name
      return ''
    })
    .filter(Boolean)
}

/**
 * Whether a Wallpaper Engine process is currently running.
 * tasklist output is localized, so presence is detected by matching the
 * process name itself rather than parsing status text.
 * @returns {Promise<boolean>}
 */
export async function isWallpaperEngineRunning() {
  for (const exe of ['wallpaper32.exe', 'wallpaper64.exe']) {
    const result = await execCapture('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'])
    if ((result.stdout || '').toLowerCase().includes(exe)) return true
  }
  return false
}

/**
 * Launch Wallpaper Engine detached and wait for its process to appear.
 * @param {string} exePath Wallpaper Engine executable.
 * @returns {Promise<boolean>} True when running within the startup window.
 */
export async function startWallpaperEngine(exePath) {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: true })
    // A missing executable reports through an async 'error' event — without a
    // listener it would crash the host process. The startup poll below is the
    // success signal, so the failure is simply dropped here.
    child.on('error', () => {})
    child.unref()
  } catch {
    return false
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(1_000)
    if (await isWallpaperEngineRunning()) return true
  }
  return false
}

/**
 * Read the currently selected wallpapers from Wallpaper Engine's config.json
 * (written in real time when the selection changes). The file lives next to
 * the executable with one top-level section per Windows user.
 * The `-control getWallpaper` CLI only writes to the console of the original
 * Wallpaper Engine process, so it cannot be captured reliably.
 * @param {string} exePath Wallpaper Engine executable.
 * @returns {Promise<Record<string, string> | null>} Map of monitor name
 *   (e.g. "Monitor0") to the active wallpaper file, or null when unreadable.
 */
export async function readCurrentWallpapers(exePath) {
  const configPath = path.join(path.dirname(exePath), 'config.json')
  let config
  try {
    config = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  } catch {
    return null
  }
  let section = config[os.userInfo().username]
  if (!section?.general?.wallpaperconfig) {
    section = Object.values(config).find(
      (value) => value && typeof value === 'object' && value.general?.wallpaperconfig,
    )
  }
  const selected = section?.general?.wallpaperconfig?.selectedwallpapers
  if (!selected || typeof selected !== 'object') return null
  const monitors = {}
  for (const [monitor, entry] of Object.entries(selected)) {
    if (entry && typeof entry.file === 'string' && entry.file) {
      monitors[monitor] = entry.file
    }
  }
  return monitors
}

/**
 * Send a `-control` command to the running Wallpaper Engine instance.
 * The controller process forwards to the running instance and exits; it does
 * not report whether the command succeeded.
 * @param {string} exePath Wallpaper Engine executable.
 * @param {string[]} args Arguments after `-control` (e.g. `['pause']` or
 *   `['openWallpaper', '-file', 'C:\\...\\project.json']`).
 * @returns {Promise<{ code: number | null, stdout: string, error?: string }>}
 */
export function runControl(exePath, args) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    let child
    try {
      child = spawn(exePath, ['-control', ...args], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (error) {
      finish({ code: null, error: String(error) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ code: null, error: 'timeout' })
    }, CONTROL_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: null, error: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      finish({ code, stdout: '' })
    })
    child.unref()
  })
}
