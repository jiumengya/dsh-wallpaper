/**
 * Minimal mechanism check: does `res.end(data)` on a response whose client
 * already disconnected raise an uncaught 'error' on the response stream?
 * Mirrors handlePreview's shape: await readFile, then writeHead + end.
 * @module mini-destroy-repro
 */
import http from 'node:http'
import net from 'node:net'

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT EXCEPTION:', e.code ?? e.message)
  process.exit(42)
})

const server = http.createServer(async (req, res) => {
  const buffer = Buffer.alloc(8 * 1024 * 1024) // stand-in for a large preview read
  await new Promise((r) => setTimeout(r, 120)) // widen the abort window
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(buffer.length) })
  res.end(buffer)
  console.log('handler finished end() without sync throw')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write('GET /preview HTTP/1.1\r\nHost: x\r\n\r\n')
  })
  sock.on('connect', () => {
    setTimeout(() => {
      console.log('client destroying socket (reload abort)')
      sock.destroy()
    }, 30)
  })
})

setTimeout(() => { console.log('survived: no uncaught exception'); process.exit(0) }, 1500)
