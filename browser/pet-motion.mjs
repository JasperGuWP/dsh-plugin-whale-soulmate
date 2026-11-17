// Real locomotion for the desktop pet: plan a random-direction target across the
// screens (2D roam: left/right/up/down/diagonal), then interpolate left/top each
// frame. Progress comes from the front video's currentTime for once-walks
// (lead/tail stillness windows), or from elapsed time for the PNG fallback —
// NEVER from a looping video (currentTime wraps → jump).
// Zero require, dependency-injected getters (no render-time snapshots).
// No rAF of its own: the widget's existing frame() calls step(t).
//
// Fallback policy lives in the widget (state authority): when the walk video never
// becomes ready, step() stops and calls deps.onFallback so the widget can re-plan
// a PNG walk with a dwell-estimated distance. Motion never re-plans itself.

const WAIT_READY_MS = 3000
const MIN_DIST = 60
const MOVE_THRESHOLD = 24
const EDGE_PAD = 0 // 贴屏幕/页边,不留内缩

function createPetMotion(deps) {
  // deps (all getters): root / viewport / size / height? / screens? / isDragging /
  //   isMinimized / reducedMotion / video (front WALK <video> or null) / wantVideo / onFallback.
  let token = 0
  let walk = null // { startX, startY, targetX, targetY, dirX, dirY, t0, dwellMs, leadSec, tailSec, speedPxSec, pending, videoMode, waitStart }

  function rootEl() { return typeof deps.root === 'function' ? deps.root() : null }
  function viewport() { return deps.viewport() }
  function sizePx() { return Number(deps.size()) || 148 }
  function heightPx() { return Number(typeof deps.height === 'function' ? deps.height() : deps.size()) || 148 }
  function screens() { return (typeof deps.screens === 'function' && deps.screens()) || null }
  function frontVideo() { return typeof deps.video === 'function' ? deps.video() : null }
  function videoDuration(v) {
    const d = v && Number(v.duration)
    return Number.isFinite(d) && d > 0 ? d : 0
  }
  function clampX(x, W, size) {
    return Math.min(Math.max(x, EDGE_PAD), Math.max(EDGE_PAD, W - size - EDGE_PAD))
  }
  function clampY(y, H, size) {
    return Math.min(Math.max(y, EDGE_PAD), Math.max(EDGE_PAD, H - size - EDGE_PAD))
  }
  /** 夹到屏幕并集:中心落在某屏内即合法;洞列/洞行则夹进最近屏,漫游不会停在没有屏幕的地方。 */
  function clampToScreens(x, y, w, h, W, H) {
    x = clampX(x, W, w)
    y = clampY(y, H, h)
    const list = screens()
    if (!list || !list.length) return { x, y }
    const cx = x + w / 2
    const cy = y + h / 2
    for (const s of list) {
      if (cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h) return { x, y }
    }
    let best = null
    let bd = Infinity
    for (const s of list) {
      const px = Math.min(Math.max(cx, s.x + w / 2), Math.max(s.x + w / 2, s.x + s.w - w / 2))
      const py = Math.min(Math.max(cy, s.y + h / 2), Math.max(s.y + h / 2, s.y + s.h - h / 2))
      const d = (px - cx) * (px - cx) + (py - cy) * (py - cy)
      if (d < bd) { bd = d; best = { x: px - w / 2, y: py - h / 2 } }
    }
    return best || { x, y }
  }
  function place(root, x, y) {
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.left = x + 'px'
    root.style.top = y + 'px'
  }
  /** Distance for a walk: real video duration when known, else dwell estimate (§5.6). */
  function travelDist(speed, durSec, dwellMs, span) {
    const secs = durSec > 0 ? durSec : dwellMs / 1000
    return Math.min(Math.max(speed * secs, MIN_DIST), span * 0.6)
  }

  /** Plan one roam on entering the walk/run state: random angle over the full
   *  circle, distance tied to video pace, target clamped into the screen union.
   *  Video walks stay pending until the front video's duration is readable; the
   *  direction is locked once, never mid-walk. */
  function plan(opts) {
    stop()
    const root = rootEl()
    if (!root) return false
    if (deps.reducedMotion() || deps.isMinimized() || deps.isDragging()) return false
    const { width: W, height: H } = viewport()
    const w = sizePx()
    const h = heightPx()
    const rect = root.getBoundingClientRect()
    const speed = Number(opts && opts.speedPxSec) || 40
    const dwellMs = Number(opts && opts.dwellMs) || 4000
    const leadSec = Number(opts && opts.leadSec) || 0
    const tailSec = Number(opts && opts.tailSec) || 0
    const wantVideo = typeof deps.wantVideo === 'function' ? !!deps.wantVideo() : false
    const dur = videoDuration(frontVideo())
    const videoMode = wantVideo && dur > 0
    const dist = travelDist(speed, videoMode ? dur : 0, dwellMs, Math.min(W, H))
    const startX = clampX(rect.left, W, w)
    const startY = clampY(rect.top, H, h)
    const angle = Math.random() * Math.PI * 2
    let dirX = Math.cos(angle)
    let dirY = Math.sin(angle)
    let t = clampToScreens(startX + dirX * dist, startY + dirY * dist, w, h, W, H)
    if (Math.hypot(t.x - startX, t.y - startY) < MOVE_THRESHOLD) {
      dirX = -dirX
      dirY = -dirY
      t = clampToScreens(startX + dirX * dist, startY + dirY * dist, w, h, W, H)
      if (Math.hypot(t.x - startX, t.y - startY) < MOVE_THRESHOLD) return false
    }
    walk = {
      startX, startY, targetX: t.x, targetY: t.y, dirX, dirY,
      t0: 0, dwellMs, leadSec, tailSec, speedPxSec: speed,
      pending: wantVideo && !videoMode, videoMode, waitStart: null,
    }
    return { facing: t.x > startX ? 1 : -1 }
  }

  /** Jump to the target and finish (ended / hidden / explicit commit). */
  function commit() {
    if (!walk) return
    const root = rootEl()
    if (root) place(root, walk.targetX, walk.targetY)
    walk = null
    token++
  }

  /** Per-frame drive; called from the widget's existing rAF loop. */
  function step(t) {
    if (!walk) return
    if (deps.isDragging() || deps.isMinimized()) { stop(); return }
    const root = rootEl()
    if (!root) { stop(); return }
    if (walk.pending) {
      const dur = videoDuration(frontVideo())
      if (dur > 0) {
        // Walk video ready: lock the real-distance target now (never mid-walk).
        const { width: W, height: H } = viewport()
        const w = sizePx()
        const h = heightPx()
        const dist = travelDist(walk.speedPxSec, dur, walk.dwellMs, Math.min(W, H))
        const t2 = clampToScreens(walk.startX + walk.dirX * dist, walk.startY + walk.dirY * dist, w, h, W, H)
        walk.targetX = t2.x
        walk.targetY = t2.y
        walk.videoMode = true
        walk.pending = false
        walk.t0 = t
      } else {
        if (walk.waitStart == null) walk.waitStart = t
        if (t - walk.waitStart > WAIT_READY_MS) {
          stop()
          if (typeof deps.onFallback === 'function') deps.onFallback()
        }
        return
      }
    }
    let u
    if (walk.videoMode) {
      const v = frontVideo()
      if (!v) { stop(); return } // state switched away; widget owns the exit
      const dur = videoDuration(v) || 1
      const ct = Number(v.currentTime) || 0
      const window = Math.max(0.1, dur - walk.leadSec - walk.tailSec)
      if (ct <= walk.leadSec) u = 0
      else if (ct >= dur - walk.tailSec) u = 1
      else u = (ct - walk.leadSec) / window
    } else {
      u = Math.min(1, (t - walk.t0) / Math.max(1, walk.dwellMs))
    }
    place(root, walk.startX + (walk.targetX - walk.startX) * u, walk.startY + (walk.targetY - walk.startY) * u)
    if (u >= 1) commit()
  }

  /** Invalidate any in-flight walk (drag / minimize / stopPet / destroy / state exit). */
  function stop() {
    walk = null
    token++
  }

  /** Keep an already-positioned pet inside the viewport after a window resize. */
  function clamp() {
    const root = rootEl()
    if (!root || !root.style.left) return // still right/bottom anchored → untouched
    const { width: W, height: H } = viewport()
    const rect = root.getBoundingClientRect()
    const c = clampToScreens(rect.left, rect.top, sizePx(), heightPx(), W, H)
    place(root, c.x, c.y)
  }

  return {
    plan, step, stop, clamp, commit,
    active() { return walk !== null },
    pending() { return !!(walk && walk.pending) },
  }
}

module.exports = { createPetMotion }
