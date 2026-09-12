/**
 * Live render scan: boot the real backend, drive headless Edge over CDP,
 * apply every scene wallpaper in turn, screenshot each, and rank by a
 * "black squares on bright background" heuristic so broken renders surface.
 * Saves PNGs to test/scan-out/.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const NODE = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node.exe'
const CLI = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OVERLAY = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\desktop.yml'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9224
const OUT = 'D:\\项目\\dsh-native\\plugins\\dsh-wallpaper\\test\\scan-out'
const ONLY = process.argv[2] ? process.argv[2].split(',') : null

mkdirSync(OUT, { recursive: true })

const backend = spawn(NODE, [CLI, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
let beOut = ''
backend.stdout.on('data', (d) => { beOut += d })
backend.stderr.on('data', (d) => { beOut += d })
const baseUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('backend timeout\n' + beOut)), 60_000)
  backend.stdout.on('data', (d) => {
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d))
    if (m) { clearTimeout(t); resolve(m[1]) }
  })
})
console.log('backend', baseUrl)

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\edge-wpscan',
  '--window-size=1280,800', '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' })
await delay(3_000)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value ?? null
}

await send('Page.enable')
await send('Page.navigate', { url: baseUrl })
await delay(9_000)

const wpList = await (await fetch(baseUrl + '/plugin-wallpaper/list')).json()
const items = (wpList.wallpapers || wpList || []).filter((w) => String(w.type).toLowerCase() === 'scene')
console.log('scene wallpapers:', items.length)

const results = []
for (const w of items) {
  if (ONLY && !ONLY.includes(w.id)) continue
  await fetch(baseUrl + '/plugin-wallpaper/state', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: w.id }),
  }).catch(() => null)
  // the main page only mounts the background on load — reload to pick it up
  await send('Page.navigate', { url: baseUrl })
  await delay(8_000)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, `${w.id}.png`)
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  // quick pixel metric inside the page? do it later in python; log anim state
  const st = await evaluate(`(() => {
    const c = document.querySelector('#dshWpAnim canvas')
    return { anim: !!c, body: document.body.className.slice(0, 80) }
  })()`)
  console.log(w.id, (w.title || '').slice(0, 30), 'anim:', st?.anim)
  results.push(w.id)
}

// restore the user's selection
await fetch(baseUrl + '/plugin-wallpaper/state', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '3354939387' }),
}).catch(() => null)

console.log('DONE', results.length)
edge.kill()
backend.kill()
process.exit(0)
