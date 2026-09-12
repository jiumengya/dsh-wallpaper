/**
 * Diagnose the settings-dialog readability against the live app: boot the real
 * backend, open the page in headless Edge over CDP, open the settings dialog,
 * then dump computed ink colors of dialog text, the dialog glass background,
 * and the body wallpaper state classes.
 * @module diag-settings
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const NODE = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node.exe'
const CLI = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OVERLAY = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\desktop.yml'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9223

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

// restore the user's own wallpaper selection before diagnosing
const restored = await fetch(baseUrl + '/plugin-wallpaper/state', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '3354939387' }),
}).then((r) => r.json()).catch(() => null)
console.log('restored user wallpaper:', restored && restored.id, restored && restored.mode)

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\edge-wpdiag',
  '--window-size=1600,1000', '--no-first-run', '--disable-gpu', 'about:blank',
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
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null
}

await send('Page.enable')
await send('Page.navigate', { url: baseUrl })
await delay(10_000)

const bodyClasses = await evaluate('document.body.className')
console.log('body classes:', JSON.stringify(bodyClasses))

const wpState = await evaluate('document.querySelector("#dshWpBg") ? (document.querySelector("#dshWpBg video") ? "video" : (document.querySelector("#dshWpBg iframe") ? "iframe" : "image")) : "none"')
console.log('wallpaper layer:', wpState)

// open the settings dialog (deepest element whose exact text is 设置)
const opened = await evaluate(`(() => {
  const all = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent?.trim() === '设置')
  const target = all[all.length - 1]
  if (!target) return 'no settings button found'
  target.click()
  return 'clicked ' + String(target.className).slice(0, 50)
})()`)
console.log('settings:', opened)
await delay(2_500)

const dialogInfo = await evaluate(`(() => {
  const dlg = document.querySelector('[role=dialog][aria-modal=true]')
  if (!dlg) return 'no dialog'
  const before = getComputedStyle(dlg, '::before')
  const texts = []
  const walk = (el) => {
    for (const child of el.children) {
      if (child.children.length === 0 && child.textContent.trim()) {
        const cs = getComputedStyle(child)
        if (child.textContent.trim().length > 1) {
          texts.push({ t: child.textContent.trim().slice(0, 18), color: cs.color, className: String(child.className).slice(0, 60) })
        }
      } else walk(child)
    }
  }
  walk(dlg)
  const svg = dlg.querySelector('svg')
  return {
    glass: before.backgroundColor,
    glassImage: before.backgroundImage.slice(0, 80),
    dialogClass: String(dlg.className).slice(0, 80),
    rect: (() => { const r = dlg.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } })(),
    iconColor: svg ? getComputedStyle(svg).color : null,
    textSamples: texts.slice(0, 14),
  }
})()`)
console.log('dialog:', JSON.stringify(dialogInfo, null, 1))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('D:\\项目\\dsh-native\\plugins\\dsh-wallpaper\\test\\diag-settings.png', Buffer.from(shot.result.data, 'base64'))
console.log('screenshot saved')

ws.close()
edge.kill()
spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' })
await delay(1_500)
process.exit(0)
