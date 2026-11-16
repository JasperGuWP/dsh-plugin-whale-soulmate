// Companion sprite plumbing: trim a sticker's transparent padding, then push it to
// the node half. Pure-ish helpers only — no React, no component state. The caller
// owns the "上传中…" note, because that is view state, not sprite logic.
const { API } = require('./util.mjs')

/**
 * Trim transparent padding so a sticker fills the free-floating corner instead of
 * rendering tiny inside its original 1024×576 canvas. Returns the input untouched
 * when the image is opaque edge-to-edge or cannot be decoded.
 */
async function trimSpriteDataUrl(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片解码失败'))
    el.src = dataUrl
  })
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const scratch = document.createElement('canvas')
  scratch.width = w
  scratch.height = h
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, w, h)
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX) return dataUrl
  const pad = 4
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad)
  maxY = Math.min(h - 1, maxY + pad)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  if (cw >= w * 0.96 && ch >= h * 0.96) return dataUrl
  const out = document.createElement('canvas')
  out.width = cw
  out.height = ch
  out.getContext('2d').drawImage(scratch, minX, minY, cw, ch, 0, 0, cw, ch)
  return out.toDataURL('image/png')
}

/** Read a File into a data URL. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** POST a trimmed sticker; resolves `{ url, bytes }`. Throws with a readable message. */
async function uploadSpriteFile(file) {
  const raw = await readFileAsDataUrl(file)
  const dataUrl = await trimSpriteDataUrl(raw)
  // API already ends with `/`; do not prefix another slash (→ api//sprite 404).
  const res = await fetch(API + 'sprite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return { url: data.url, bytes: data.bytes }
}

/** Drop the custom sticker server-side; resolves the fallback URL. */
async function deleteSprite(gender) {
  const route = gender === 'male' ? 'sprite-male' : 'sprite'
  const res = await fetch(API + route, { method: 'DELETE' })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data.url || ''
}

module.exports = { trimSpriteDataUrl, readFileAsDataUrl, uploadSpriteFile, deleteSprite }