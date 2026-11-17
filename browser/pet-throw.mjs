// Flick-throw physics for the desktop pet (dsh-pet 同款手感): release velocity →
// gravity + edge restitution + ground friction, sub-stepped so a fast flick never
// tunnels through the floor. Landing squashes the stage once (Q 弹).
// Zero require, dependency-injected getters. No rAF of its own: the widget's
// existing frame() calls step(t) every frame, even while no flight is running
// (a landing squash may outlive the flight that triggered it).

const MAX_SPEED = 3600 // soft cap on release speed, × throwPower
const MIN_THROW_SPEED = 200 // below this a release is a gentle put-down, not a throw
const REST_VX = 6
const SETTLE_VY = 60 // a bounce slower than this sticks to the ground (no micro-jitter)
const SQ_MS = 280
const DEFAULTS = { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1 }

function createPetThrow(deps) {
  // deps (getters / callbacks): root / stage / viewport / size → {width,height} /
  //   physics() → cfg overrides / reducedMotion / onRest(t).
  let flight = null // { x, y, vx, vy, p, lastT, grounded }
  let squash = null // { t0, depth }

  function phys() {
    const raw = (typeof deps.physics === 'function' && deps.physics()) || {}
    const out = {}
    for (const key of Object.keys(DEFAULTS)) {
      const v = Number(raw[key])
      out[key] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS[key]
    }
    out.restitution = Math.min(out.restitution, 1)
    if (out.throwPower <= 0) out.throwPower = 1
    return out
  }
  function place(root, x, y) {
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.left = x + 'px'
    root.style.top = y + 'px'
  }
  function applySquash(scale) {
    const el = typeof deps.stage === 'function' ? deps.stage() : null
    if (!el) return
    if (scale === 1) { el.style.transform = ''; return }
    el.style.transformOrigin = 'bottom center'
    el.style.transform = 'scaleX(' + (1 + (1 - scale) * 0.6) + ') scaleY(' + scale + ')'
  }

  /** Launch from (x, y) with release velocity. Returns false for a gentle put-down
   *  (too slow / reduced motion) so the caller keeps the normal drop behavior. */
  function start(x, y, vx, vy) {
    stop()
    if (deps.reducedMotion && deps.reducedMotion()) return false
    const speed = Math.hypot(vx, vy)
    if (!Number.isFinite(speed) || speed < MIN_THROW_SPEED) return false
    const p = phys()
    const cap = MAX_SPEED * p.throwPower
    const k = (speed > cap ? cap / speed : 1) * p.throwPower
    flight = { x, y, vx: vx * k, vy: vy * k, p, lastT: null, grounded: false }
    return true
  }

  /** Per-frame drive; called from the widget's existing rAF loop. */
  function step(t) {
    if (flight) {
      const root = deps.root()
      if (!root) { stop(); return }
      if (flight.lastT == null) flight.lastT = t
      const dt = Math.min(Math.max((t - flight.lastT) / 1000, 0), 1 / 30)
      flight.lastT = t
      const { width: W, height: H } = deps.viewport()
      const { width: w, height: h } = deps.size()
      // 贴屏幕边:零内缩。多屏时按宠物中心所在「列」取上下界(屏缝不是墙)。
      const screens = (typeof deps.screens === 'function' && deps.screens()) || null
      const minX = 0
      const maxX = Math.max(minX, W - w)
      const p = flight.p
      // Sub-step so a max-speed flick (≤ ~120px/frame) still lands on the exact
      // bounce frame instead of skipping past the floor.
      const n = Math.min(16, Math.max(1, Math.ceil((Math.hypot(flight.vx, flight.vy) * dt) / 16)))
      const sub = dt / n
      let landedImpact = 0
      for (let i = 0; i < n; i++) {
        flight.vy += p.gravity * sub
        const prevX = flight.x
        flight.x += flight.vx * sub
        flight.y += flight.vy * sub
        let top = 0
        let bottom = H
        if (screens && screens.length) {
          const cx = flight.x + w / 2
          let col = null
          for (const s of screens) {
            if (cx >= s.x && cx < s.x + s.w) {
              col = col
                ? { top: Math.min(col.top, s.y), bottom: Math.max(col.bottom, s.y + s.h) }
                : { top: s.y, bottom: s.y + s.h }
            }
          }
          // 洞列(该横坐标没有屏幕)是墙:退回上一位置并弹回
          if (!col) { flight.x = prevX; flight.vx = -flight.vx * p.restitution }
          else { top = col.top; bottom = col.bottom }
        }
        const maxY = Math.max(top, bottom - h)
        if (flight.x <= minX) { flight.x = minX; flight.vx = Math.abs(flight.vx) * p.restitution }
        else if (flight.x >= maxX) { flight.x = maxX; flight.vx = -Math.abs(flight.vx) * p.restitution }
        if (flight.y <= top) { flight.y = top; flight.vy = Math.abs(flight.vy) * p.restitution }
        let grounded = false
        if (flight.y >= maxY) {
          flight.y = maxY
          grounded = true
          if (flight.vy > 0) {
            // Landing Q 弹 fires only on the air→ground transition, scaled by impact.
            if (!flight.grounded && flight.vy > 200) landedImpact = Math.max(landedImpact, flight.vy)
            flight.vy = -flight.vy * p.restitution
            if (Math.abs(flight.vy) < SETTLE_VY) flight.vy = 0
          }
          flight.vx *= Math.exp(-p.groundFriction * sub)
        }
        flight.grounded = grounded
      }
      place(root, flight.x, flight.y)
      if (landedImpact && !(deps.reducedMotion && deps.reducedMotion())) {
        squash = { t0: t, depth: Math.min(0.45, Math.max(0.12, landedImpact / 3000)) }
      }
      const slow = Math.abs(flight.vx) < REST_VX && Math.abs(flight.vy) < 1
      // With gravity on, rest only counts on the ground (an apex also has vy≈0).
      const atRest = flight.grounded ? slow : (p.gravity === 0 && Math.hypot(flight.vx, flight.vy) < REST_VX)
      if (atRest) {
        flight = null
        if (typeof deps.onRest === 'function') deps.onRest(t)
      }
    }
    if (squash) {
      const u = Math.min((t - squash.t0) / SQ_MS, 1)
      // Fast dip, gentle recovery, ends exactly at 1.
      applySquash(1 - squash.depth * Math.sin(Math.PI * u) * (1 - u))
      if (u >= 1) { squash = null; applySquash(1) }
    }
  }

  /** Cancel any flight + squash (grab / minimize / hide / stopPet / destroy). */
  function stop() {
    flight = null
    if (squash) { squash = null; applySquash(1) }
  }

  return { start, step, stop, active() { return flight !== null } }
}

module.exports = { createPetThrow, MIN_THROW_SPEED, DEFAULTS }