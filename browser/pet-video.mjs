// Transparent-video playback layer for the desktop pet: A/B double-buffered <video>,
// fetch → blob → objectURL, monotonic generation discards late loads, blob LRU ≤8.
// Zero require — loadable standalone in a vm for tests.
//
// SYNC(video-cues): the six pure functions below are a verbatim copy of
// packages/soulmate-core/video-cues.mjs (DSH ModuleLoader cannot import ESM).
// test/pet-video.test.mjs runs ONE scenario table against BOTH copies — keep in sync.
function videoNameOf(st) {
  const v = st && st.video
  if (typeof v === 'string') return v || null
  if (v && typeof v === 'object' && typeof v.name === 'string' && v.name) return v.name
  return null
}
function isOnceState(st) {
  const v = st && st.video
  if (v && typeof v === 'object' && typeof v.once === 'boolean') return v.once
  return st != null && st.holdSec != null && st.dwellSec == null
}
function pickNextState(st, rand) {
  const next = (st && st.next) || {}
  const entries = Object.entries(next)
  if (!entries.length) return 'idle'
  let roll = rand()
  for (const [key, p] of entries) {
    if (roll < p) return key
    roll -= p
  }
  return 'idle'
}
function endedCue(states, name, rand) {
  const st = (states || {})[name]
  if (!st || !isOnceState(st)) return null
  return pickNextState(st, rand)
}
function prefersMov(ua, platform, maxTouchPoints) {
  const u = String(ua || '')
  if (/iPhone|iPad|iPod/i.test(u)) return true
  if (/Chrome|Chromium|Edg|OPR|Firefox|FxiOS/i.test(u)) return false
  const mac = /Mac/i.test(String(platform || '') || u)
  if (mac && Number(maxTouchPoints) > 1) return true
  return mac
}
function videoUrlFor(manifest, state, wantMov) {
  const m = manifest || {}
  if (wantMov) return (m.videoMovUrls || {})[state] || null
  return (m.videoUrls || {})[state] || null
}
// END SYNC(video-cues)

const LOAD_TIMEOUT_MS = 10000
const LRU_MAX = 8

/** Create the A/B video layer mounted inside the pet stage. */
function createPetVideoLayer({ mount, onEnded, onFail, isDragging }) {
  let gen = 0
  let active = null
  let front = null
  let paused = false
  let mirror = false
  let sizePx = 148
  let inflight = null
  const cache = new Map() // url → objectURL, insertion order = LRU
  const vids = [makeVideo(), makeVideo()]

  function makeVideo() {
    const v = document.createElement('video')
    v.className = 'sm-pet-video'
    v.muted = true
    v.draggable = false
    v.setAttribute('muted', '')
    v.setAttribute('playsinline', '')
    v.setAttribute('draggable', 'false')
    v.preload = 'auto'
    mount.appendChild(v)
    return v
  }

  function applyMirror(v) {
    v.classList.toggle('is-mirror', mirror)
  }

  function applySize() {
    // Videos fill the stage mount (CSS inset:0). sizePx is recorded for callers;
    // never expand mount.minWidth — the stage box is the sole layout authority.
    for (const v of vids) {
      v.style.height = '100%'
      v.style.width = '100%'
    }
    void sizePx
  }

  function cacheGet(url) {
    if (!cache.has(url)) return null
    const obj = cache.get(url)
    cache.delete(url)
    cache.set(url, obj) // touch → most recent
    return obj
  }

  function cachePut(url, obj) {
    cache.set(url, obj)
    while (cache.size > LRU_MAX) {
      const oldest = cache.keys().next().value
      const dead = cache.get(oldest)
      cache.delete(oldest)
      // Never revoke a URL still attached to a buffer (front or loading back).
      if (vids.every((v) => v.src !== dead)) URL.revokeObjectURL(dead)
    }
  }

  function abortInflight() {
    if (inflight) {
      try { inflight.abort() } catch (_) { /* already settled */ }
      inflight = null
    }
  }

  function fail(state) {
    hide()
    if (typeof onFail === 'function') onFail(state)
  }

  function swap(v, state, once) {
    const old = front
    front = v
    active = state
    v.classList.add('is-front')
    applyMirror(v)
    v.loop = !once
    if (old && old !== v) {
      old.classList.remove('is-front')
      old.onended = null
      old.onerror = null
      old.pause()
    }
    v.onended = () => {
      if (front !== v) return
      if (typeof isDragging === 'function' && isDragging()) return
      if (typeof onEnded === 'function') onEnded(state)
    }
    v.onerror = () => {
      if (front !== v) return
      fail(state)
    }
    if (paused) { v.pause(); return }
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => { if (front === v) fail(state) })
  }

  function load(state, url, opts) {
    const once = !!(opts && opts.once)
    if (opts && typeof opts.mirror === 'boolean') mirror = opts.mirror
    const my = ++gen
    abortInflight()
    // Interrupt immediately: stop the current front clip (e.g. think loop) so
    // eureka does not wait for the previous video to finish or keep looping.
    if (front && active !== state) {
      try { front.pause() } catch (_) { /* ignore */ }
      front.onended = null
    }
    const cached = cacheGet(url)
    if (cached) {
      const back = vids.find((v) => v !== front) || vids[0]
      back.src = cached
      const ready = () => {
        back.onloadeddata = null
        if (my !== gen) return
        swap(back, state, once)
      }
      if (back.readyState >= 2) ready()
      else back.onloadeddata = ready
      return
    }
    const ctrl = new AbortController()
    inflight = ctrl
    const timer = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS)
    fetch(url, { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.blob()
      })
      .then((blob) => {
        clearTimeout(timer)
        if (my !== gen) return
        inflight = null
        const obj = URL.createObjectURL(blob)
        cachePut(url, obj)
        const back = vids.find((v) => v !== front) || vids[0]
        back.onloadeddata = () => {
          back.onloadeddata = null
          if (my !== gen) return
          swap(back, state, once)
        }
        back.onerror = () => {
          if (my !== gen) return
          fail(state)
        }
        back.src = obj
      })
      .catch(() => {
        clearTimeout(timer)
        if (my !== gen) return
        inflight = null
        fail(state)
      })
  }

  function hide() {
    active = null
    for (const v of vids) v.classList.remove('is-front')
  }

  function clear() {
    gen++
    abortInflight()
    hide()
    front = null
    for (const v of vids) {
      v.onended = null
      v.onerror = null
      v.onloadeddata = null
      v.pause()
      v.removeAttribute('src')
    }
  }

  function dispose() {
    clear()
    for (const obj of cache.values()) URL.revokeObjectURL(obj)
    cache.clear()
    for (const v of vids) if (v.parentNode) v.parentNode.removeChild(v)
    mount.style.minWidth = ''
  }

  applySize()

  return {
    load,
    hide,
    clear,
    dispose,
    setMirror(on) { mirror = !!on; for (const v of vids) applyMirror(v) },
    setSize(px) { sizePx = Math.max(1, Math.round(Number(px) || 148)); applySize() },
    setPaused(on) {
      paused = !!on
      if (!front) return
      if (paused) front.pause()
      else {
        const p = front.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      }
    },
    activeState() { return active },
    frontVideo() { return front },
  }
}

module.exports = { createPetVideoLayer, videoNameOf, isOnceState, pickNextState, endedCue, prefersMov, videoUrlFor }
