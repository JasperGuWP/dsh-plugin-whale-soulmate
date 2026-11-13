// Alpha hit-test for the free-floating pet sticker.
// Transparent pixels must pass clicks through to whatever sits under the pet
// (chat / page chrome); only opaque character pixels own the drag target.

const ALPHA_MIN = 16

/**
 * Sample one display pixel of a <video> (object-fit: contain) or <img>.
 * Same-origin / blob URLs only; cross-origin taint → return null.
 */
function sampleMediaAlpha(media, clientX, clientY) {
  if (!media) return null
  const rect = media.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) {
    return 0
  }
  const dx = clientX - rect.left
  const dy = clientY - rect.top
  const natW = media.videoWidth || media.naturalWidth || 0
  const natH = media.videoHeight || media.naturalHeight || 0
  if (!natW || !natH) return null
  // object-fit: contain letterbox → map display → source.
  const scale = Math.min(rect.width / natW, rect.height / natH)
  const rw = natW * scale
  const rh = natH * scale
  const ox = (rect.width - rw) / 2
  const oy = (rect.height - rh) / 2
  if (dx < ox || dy < oy || dx >= ox + rw || dy >= oy + rh) return 0
  const sx = Math.min(natW - 1, Math.max(0, Math.floor((dx - ox) / scale)))
  const sy = Math.min(natH - 1, Math.max(0, Math.floor((dy - oy) / scale)))
  try {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(media, sx, sy, 1, 1, 0, 0, 1, 1)
    return ctx.getImageData(0, 0, 1, 1).data[3]
  } catch (_) {
    return null
  }
}

/**
 * True when the pointer is over an opaque pet pixel.
 * @param {{ failClosed?: boolean }} opts - when true (default for live pet),
 *   unreadable alpha is treated as transparent so the page underneath stays usable.
 */
function isOpaquePetPixel({ clientX, clientY, frontVideo, spriteImg, failClosed }) {
  const closed = failClosed !== false
  const video = typeof frontVideo === 'function' ? frontVideo() : frontVideo
  if (video && video.classList && video.classList.contains('is-front')) {
    const a = sampleMediaAlpha(video, clientX, clientY)
    if (a != null) return a > ALPHA_MIN
    return !closed
  }
  if (spriteImg && spriteImg.style && spriteImg.style.visibility !== 'hidden'
      && spriteImg.style.display !== 'none') {
    const a = sampleMediaAlpha(spriteImg, clientX, clientY)
    if (a != null) return a > ALPHA_MIN
    return !closed
  }
  // No media yet (boot / canvas avatar) → keep a hit target so the sticker stays usable.
  return true
}

module.exports = { isOpaquePetPixel, sampleMediaAlpha, ALPHA_MIN }
