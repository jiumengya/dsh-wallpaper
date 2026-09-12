/**
 * Diagnose sidebar text softness in the live app.
 * Usage: node diag-sidebar-blur.mjs [wallpaperId]
 * Boots the real backend, opens headless Edge, mounts the selected background,
 * dumps sidebar DOM/computed styles and captures a screenshot.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const id = process.argv[2] || '3439763075'
const NODE = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node.exe'
const CLI = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OVERLAY = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\desktop.yml'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9226
const OUT = `C:\\Users\\jiuyu\\AppData\\Local\\Temp\\dshwp-sidebar-${id}.png`
const backend = spawn(NODE, [CLI, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
backend.stdout.on('data', (d) => { out += d })
backend.stderr.on('data', (d) => { out += d })
const base = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(out)), 60000)
  backend.stdout.on('data', (d) => { const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]) } })
})
await fetch(base + '/plugin-wallpaper/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}\\edge-sidebar-diag`, '--window-size=1440,810', '--disable-gpu', '--no-first-run', base], { stdio: 'ignore' })
await delay(4000)
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let n = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value ?? { error: r.result?.exceptionDetails?.text } }
await send('Page.enable')
await delay(9000)
const info = await ev(`(() => {
  const all = [...document.querySelectorAll('body *')];
  const side = all.find(e => /sidebarCol/i.test(e.className || ''));
  const text = side ? [...side.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim()).slice(0, 40) : [];
  const css = e => { const s = getComputedStyle(e); return { tag:e.tagName, cls:String(e.className), text:e.textContent.trim().slice(0,60), color:s.color, opacity:s.opacity, filter:s.filter, transform:s.transform, textShadow:s.textShadow, font:s.font, fontSize:s.fontSize, fontWeight:s.fontWeight, lineHeight:s.lineHeight, willChange:s.willChange, isolation:s.isolation, contain:s.contain, mixBlendMode:s.mixBlendMode } };
  return { body: { cls: document.body.className, transform:getComputedStyle(document.body).transform }, side: side && css(side), text: text.map(css), html: side?.outerHTML.slice(0, 5000) };
})()`)
console.log(JSON.stringify(info, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot', OUT)
edge.kill(); backend.kill()
