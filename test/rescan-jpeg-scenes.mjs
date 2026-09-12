// Boot the real backend, warm the v5 scene-art cache for the JPEG-layer
// wallpapers (first extraction takes seconds; the endpoint holds the
// request), then screenshot each in headless Edge.
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const NODE = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node.exe'
const CLI = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OVERLAY = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\desktop.yml'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9225
const OUT = 'D:\\项目\\dsh-native\\plugins\\dsh-wallpaper\\test\\scan-out'
const IDS = ['2847177270', '2847178647', '2850222068', '2852937933', '2861925918', '2874035368', '3030735160', '3175038430', '3300879365', '3514379430', '3600525001', '3600720818']

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

// warm the extraction cache (v4 entries are invalid under v5)
for (const id of IDS) {
  const t0 = Date.now()
  const r = await fetch(`${baseUrl}/plugin-wallpaper/scene-art/${id}`).catch((e) => ({ status: String(e) }))
  console.log('warm', id, r.status, `${Date.now() - t0}ms`)
  await r.arrayBuffer?.().catch(() => {})
}

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\edge-wprescan',
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
await send('Page.enable')
await send('Page.navigate', { url: baseUrl })
await delay(8_000)

for (const id of IDS) {
  await fetch(baseUrl + '/plugin-wallpaper/state', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => null)
  await send('Page.navigate', { url: baseUrl })
  await delay(7_000)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(OUT, `${id}.png`), Buffer.from(shot.result.data, 'base64'))
  console.log('shot', id)
}

await fetch(baseUrl + '/plugin-wallpaper/state', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '3354939387' }),
}).catch(() => null)
console.log('DONE')
edge.kill()
backend.kill()
process.exit(0)
