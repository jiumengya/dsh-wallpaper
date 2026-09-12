// Standalone smoke test for the scene-art module against real workshop wallpapers.
import { extractSceneArt } from '../pkg/lib/scene-art.js'
import fs from 'node:fs'
import path from 'node:path'

const workshop = 'E:/steam/steamapps/workshop/content/431960'
const outDir = path.resolve('test/scene-art-out')
fs.mkdirSync(outDir, { recursive: true })

const ids = process.argv.slice(2)
const targets = ids.length > 0
  ? ids.map((id) => ({ name: id, dir: path.join(workshop, id) }))
  : fs.readdirSync(workshop, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(workshop, d.name, 'scene.pkg')))
      .map((d) => ({ name: d.name, dir: path.join(workshop, d.name) }))

let ok = 0
const failures = []
for (const t of targets) {
  const started = Date.now()
  try {
    const art = await extractSceneArt(path.join(t.dir, 'scene.pkg'))
    const ext = art.contentType === 'image/png' ? 'png' : 'jpg'
    fs.writeFileSync(path.join(outDir, `${t.name}.${ext}`), art.data)
    if (art.data.length < 4096) throw new Error(`suspiciously small output (${art.data.length} bytes)`)
    ok++
    console.log(`ok   ${t.name} ${art.contentType} ${(art.data.length / 1048576).toFixed(1)}MB ${Date.now() - started}ms`)
  } catch (error) {
    failures.push(t.name)
    console.log(`fail ${t.name}: ${error.message}`)
  }
}
console.log(`\n${ok}/${targets.length} extracted; failures: ${failures.join(', ') || 'none'}`)
process.exit(failures.length > 0 ? 1 : 0)
