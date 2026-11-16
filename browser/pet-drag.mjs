// Pointer drag + alpha click-through on the pet hit box.
// Transparent pixels drop hit pointer-events so the page underneath scrolls/clicks.
const { isOpaquePetPixel } = require('./pet-hit.mjs')

// Release velocity comes from the last ~120ms of pointer travel: a flick reads fast,
// holding still before letting go reads ~0 (gentle put-down).
const VEL_WINDOW_MS = 120
function releaseVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return { vx: 0, vy: 0 }
  const last = samples[samples.length - 1]
  let first = null
  for (const s of samples) {
    if (last.t - s.t <= VEL_WINDOW_MS) { first = s; break }
  }
  if (!first || first === last) return { vx: 0, vy: 0 }
  const dt = (last.t - first.t) / 1000
  if (dt < 0.016) return { vx: 0, vy: 0 }
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
}

/**
 * Wire drag-to-move + continuous alpha gating on the hit element.
 * onGrab fires on every valid pointerdown (before any movement) so a flying pet
 * can be caught; onDragEnd receives the release velocity for flick-throw.
 */
function wirePetDrag({ widget, hitEl, spriteImg, getPet, getPetLayer, onGrab, onDragStart, onDragEnd, setSwallow }) {
  let dragMoved = false
  let dragOff = null
  let hitOn = true
  let lastSampleAt = 0
  const target = hitEl || widget

  function setHit(on) {
    if (on === hitOn) return
    hitOn = on
    if (hitEl) hitEl.style.pointerEvents = on ? 'auto' : 'none'
  }

  function sample(clientX, clientY) {
    const layer = getPetLayer && getPetLayer()
    return isOpaquePetPixel({
      clientX,
      clientY,
      frontVideo: () => (layer && layer.frontVideo ? layer.frontVideo() : null),
      spriteImg,
      failClosed: true,
    })
  }

  const onMoveGate = (e) => {
    if (!getPet()) { setHit(true); return }
    const now = performance.now()
    if (now - lastSampleAt < 32 && hitOn) return
    lastSampleAt = now
    if (dragOff) { setHit(true); return }
    setHit(sample(e.clientX, e.clientY))
  }
  window.addEventListener('pointermove', onMoveGate, { passive: true })

  target.addEventListener('pointerdown', (e) => {
    if (!getPet()) return
    if (e.button != null && e.button !== 0) return

    const opaque = sample(e.clientX, e.clientY)
    setHit(opaque)
    if (!opaque) return

    e.preventDefault()
    if (typeof onGrab === 'function') onGrab()
    const rect = widget.getBoundingClientRect()
    dragMoved = false
    dragOff = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top }
    let samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }]
    try { target.setPointerCapture(e.pointerId) } catch (_) { /* optional */ }

    const move = (ev) => {
      if (!dragOff) return
      const dx = ev.clientX - dragOff.x
      const dy = ev.clientY - dragOff.y
      if (!dragMoved && Math.hypot(dx, dy) > 6) {
        dragMoved = true
        setSwallow(true)
        widget.classList.add('sm-dragging')
        widget.style.right = 'auto'
        widget.style.bottom = 'auto'
        onDragStart(performance.now())
      }
      if (dragMoved) {
        widget.style.left = (dragOff.left + dx) + 'px'
        widget.style.top = (dragOff.top + dy) + 'px'
        samples.push({ t: performance.now(), x: ev.clientX, y: ev.clientY })
        if (samples.length > 12) samples.shift()
      }
    }
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try { target.releasePointerCapture(ev.pointerId) } catch (_) { /* optional */ }
      widget.classList.remove('sm-dragging')
      if (dragMoved) {
        samples.push({ t: performance.now(), x: ev.clientX, y: ev.clientY })
        onDragEnd(performance.now(), releaseVelocity(samples))
        const kill = (ce) => {
          ce.preventDefault()
          ce.stopPropagation()
          setSwallow(false)
          window.removeEventListener('click', kill, true)
        }
        window.addEventListener('click', kill, true)
        setTimeout(() => {
          window.removeEventListener('click', kill, true)
          setSwallow(false)
        }, 50)
      }
      dragMoved = false
      dragOff = null
      setHit(sample(ev.clientX, ev.clientY))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
}

module.exports = { wirePetDrag, releaseVelocity }
