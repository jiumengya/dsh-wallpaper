/**
 * Worker entry for scene-art extraction. Decoding a large DXT/LZ4 texture is
 * CPU-bound for seconds; running it on the backend's event loop would stall
 * every other request, so `scene-art.js` extraction runs here off-thread.
 * Accepts the pkg path directly or `{ pkgPath, weAssetsDir }`. Alongside the
 * art image the message carries the particle-animation export when present
 * (`anim` with per-texture PNG buffers), the flat art frame (`flat`, image
 * layers without the baked particles) and the MP4 video export (`videos`
 * with per-layer MP4 buffers).
 * @module @deepseek-ai/dsh-wallpaper/scene-art-worker
 */
import { parentPort } from 'node:worker_threads'
import { extractSceneArt } from './scene-art.js'

parentPort.on('message', async (msg) => {
  const req = typeof msg === 'string' ? { pkgPath: msg } : msg
  try {
    const art = await extractSceneArt(req.pkgPath, req.weAssetsDir ?? '')
    // No transfer list: small PNG encodes (< 4 KB) are allocated from the
    // shared 8 KB Buffer pool, and transferring a pooled ArrayBuffer
    // (byteOffset ≠ 0, or shared with live buffers) throws DataCloneError.
    // Extraction already costs seconds; the clone copy is milliseconds.
    parentPort.postMessage({
      data: art.data,
      contentType: art.contentType,
      anim: art.anim ?? null,
      flat: art.flat ?? null,
      videos: art.videos ?? null,
    })
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message ?? error) })
  }
})
