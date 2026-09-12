/**
 * Mechanism check 2: client aborts with unread data in flight (TCP RST), the
 * server keeps piping a large file into the response. pipe() does not handle
 * destination-stream errors — an unlistened 'error' on res crashes the process.
 * This mirrors the wallpaper video/preview streaming paths.
 * @module mini-rst-repro
 */
import http from 'node:http'
import net from 'node:net'
import { createReadStream } from 'node:fs'
import { writeFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT EXCEPTION:', e.code ?? e.message)
  process.exit(42)
})

const big = 'D:\\项目\\dsh-native\\plugins\\dsh-wallpaper\\test\\big.tmp'
writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7))

const mode = process.argv[2] ?? 'pipe' // pipe | end

const server = http.createServer(async (req, res) => {
  if (mode === 'pipe') {
    // tryStreamFile shape: source guarded, res only guarded by 'close'
    const stream = createReadStream(big)
    stream.on('error', () => { res.destroy() })
    res.on('close', () => { stream.destroy() })
    res.writeHead(200, { 'content-length': String(64 * 1024 * 1024) })
    stream.pipe(res)
  } else {
    // preview shape: read then end
    const { readFile } = await import('node:fs/promises')
    const data = await readFile(big)
    res.writeHead(200, { 'content-length': String(data.length) })
    res.end(data)
  }
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const sock = net.connect(port, '127.0.0.1')
  sock.on('connect', () => {
    sock.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n')
  })
  let got = 0
  sock.on('data', (d) => {
    got += d.length
    if (got > 256 * 1024) {
      // destroy with unread bytes buffered -> RST toward the server
      console.log('client RST after', got, 'bytes')
      sock.destroy()
    }
  })
})

await delay(3000)
console.log('survived 3s, mode', mode)
rmSync(big, { force: true })
process.exit(0)
