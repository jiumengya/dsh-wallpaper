/**
 * Crash repro: boot the real desktop-profile backend, then replay the user's
 * session shape against the wallpaper routes — open settings (preview grid),
 * switch between video/web/scene wallpapers, abort background streams mid-flight
 * (page reload / wallpaper switch), and keep a web wallpaper's asset traffic
 * flowing. The child's exit code and the last backend output are reported.
 * @module repro-crash
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const NODE = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node.exe'
const CLI = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OVERLAY = 'C:\\Users\\jiuyu\\AppData\\Local\\DshNative\\desktop.yml'

const child = spawn(NODE, [CLI, '--profile', 'web', '--patch', OVERLAY, '--no-open', '--port', '0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendOut = ''
child.stdout.on('data', (d) => { backendOut += d; process.stdout.write('[be] ' + d) })
child.stderr.on('data', (d) => { backendOut += d; process.stdout.write('[be:err] ' + d) })

let exited = null
child.on('exit', (code) => { exited = code })

const baseUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('backend not ready in 60s\n' + backendOut)), 60_000)
  child.stdout.on('data', (d) => {
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d))
    if (m) { clearTimeout(timer); resolve(m[1]) }
  })
})
console.log('READY', baseUrl)

async function j(path, init) {
  const res = await fetch(baseUrl + path, init)
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: res.status, body }
}

async function abortStream(path, ms) {
  const ac = new AbortController()
  const p = fetch(baseUrl + path, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      return 'drained'
    })
    .catch((e) => 'aborted:' + String(e?.cause?.code ?? e?.name ?? e))
  await delay(ms)
  ac.abort()
  return p
}

const list = await j('/plugin-wallpaper/list')
console.log('list', list.status, 'total', list.body.total)
const walls = list.body.wallpapers
const pick = (type) => walls.find((w) => w.type === type)
const video = pick('video')
const web = pick('web')
const scene = pick('scene')
console.log('candidates', { video: video?.id, web: web?.id, scene: scene?.id })

const steps = []
const step = (name, fn) => steps.push({ name, fn })

// settings grid traffic: 20 preview images concurrently, twice
step('preview-grid', async () => {
  for (let round = 0; round < 2; round++) {
    await Promise.all(walls.slice(0, 20).map((w) =>
      w.preview
        ? fetch(baseUrl + w.preview).then((r) => r.body.cancel()).catch(() => {})
        : Promise.resolve()))
  }
})

// background video playing, then the page reloads mid-stream (3 aborts)
step('video-aborts', async () => {
  if (!video) return 'no video wallpaper'
  const results = await Promise.all([
    abortStream(`/plugin-wallpaper/media/${video.id}`, 800),
    abortStream(`/plugin-wallpaper/media/${video.id}`, 1_200),
    abortStream(`/plugin-wallpaper/media/${video.id}`, 2_000),
  ])
  return results.join(' | ')
})

// rapid switches: video -> web -> scene -> video (what the settings page does)
step('rapid-switches', async () => {
  const order = [video, web, scene, video, scene, web].filter(Boolean)
  for (const w of order) {
    const r = await j('/plugin-wallpaper/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: w.id }),
    })
    if (r.status !== 200) return `switch to ${w.id} failed: ${r.status}`
  }
  return 'ok'
})

// play the current background for real: sustained video stream for ~6s, aborted mid-read
step('sustained-video', async () => {
  const state = await j('/plugin-wallpaper/state')
  if (state.body.mode === 'video') {
    return abortStream(state.body.src, 6_000)
  }
  if (state.body.mode === 'frame') {
    const html = await fetch(baseUrl + state.body.src).then((r) => r.text()).catch((e) => 'frame err ' + e)
    return 'frame loaded ' + String(html).length + ' bytes'
  }
  return 'mode ' + state.body.mode
})

// web wallpaper asset traffic: load entry html, then hammer a few asset paths
step('web-assets', async () => {
  if (!web) return 'no web wallpaper'
  await j('/plugin-wallpaper/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: web.id }),
  })
  const state = await j('/plugin-wallpaper/state')
  const entry = await fetch(baseUrl + state.body.src)
  const html = await entry.text()
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^[a-z]+:/i.test(s)).slice(0, 15)
  const results = await Promise.all(refs.map((ref) =>
    fetch(baseUrl + '/plugin-wallpaper/web/' + web.id + '/' + ref.replace(/^\.?\//, ''))
      .then((r) => { r.body.cancel(); return r.status })
      .catch((e) => 'ERR:' + String(e?.cause?.code ?? e?.name ?? e))))
  return `entry ${entry.status}, ${refs.length} assets: ${results.join(',')}`
})

// malformed / hostile requests while the background is playing
step('hostile', async () => {
  const probes = [
    () => j('/plugin-wallpaper/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }),
    () => j('/plugin-wallpaper/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'zzz' }) }),
    () => fetch(baseUrl + '/plugin-wallpaper/media/9999999').then((r) => r.status),
    () => fetch(baseUrl + '/plugin-wallpaper/media/' + (video?.id ?? '0') + '/', { headers: { range: 'bytes=abc' } }).then((r) => r.status),
    () => fetch(baseUrl + '/plugin-wallpaper/web/' + (web?.id ?? '0') + '/..%2f..%2f..%2fproject.json').then((r) => r.status),
    () => fetch(baseUrl + '/plugin-wallpaper/preview/').then((r) => r.status),
  ]
  const results = []
  for (const p of probes) results.push(await p().catch((e) => 'ERR:' + String(e?.cause?.code ?? e?.name ?? e)))
  return results.join(' | ')
})

for (const s of steps) {
  if (exited !== null) { console.log('BACKEND DIED before step:', s.name, 'code', exited); break }
  console.log('--', s.name)
  const out = await s.fn()
  console.log('  ->', out)
  if (exited !== null) { console.log('BACKEND DIED during step:', s.name, 'code', exited); break }
}

// idle observation window: the reported crash happened minutes into a session
for (let i = 0; i < 6 && exited === null; i++) {
  await delay(5_000)
  const state = await j('/plugin-wallpaper/state').catch(() => null)
  console.log(`idle ${i + 1}/6 alive=${exited === null} state=${state?.status ?? 'fetch failed'}`)
}

if (exited === null) {
  console.log('SURVIVED — killing child')
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
} else {
  console.log('FINAL: backend exited with code', exited)
  console.log('last backend output:\n' + backendOut.slice(-3000))
}
process.exit(0)
