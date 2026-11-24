// Process layer: the sky shows memory *happening*, not just memory *existing*.
//
// Two sources feed it:
//   * graph diff — stars that appeared since the previous poll ignite and pull their
//     cluster's dust inward for a few seconds (a night's dream landing looks like a
//     constellation forming, because that is what it is).
//   * activity events — `memory-progress` stages light the matching star while she
//     works; `intent` decisions flash once (restraint included: a thought that was
//     held back still happened).
//
// State is per canvas (WeakMap), time is numeric, and everything expires on its own —
// a stale spark must never linger into tomorrow's sky.

const fxByCanvas = new WeakMap()

const IGNITE_MS = 6500
const FLASH_MS = 3200
const PROGRESS_TTL_MS = 90_000

function fxOf(canvas) {
  let fx = fxByCanvas.get(canvas)
  if (!fx) {
    fx = { seen: null, births: new Map(), flashes: [], progress: new Map(), lastEventSeq: 0 }
    fxByCanvas.set(canvas, fx)
  }
  return fx
}

/** Diff the graph: newly appeared ids ignite. First poll only seeds — no birthday storm. */
function noteGraph(canvas, graph, nowMs) {
  const fx = fxOf(canvas)
  const ids = new Set(((graph && graph.nodes) || []).map((n) => n && n.id).filter(Boolean))
  if (fx.seen) {
    for (const id of ids) {
      if (!fx.seen.has(id) && !fx.births.has(id)) fx.births.set(id, nowMs)
    }
  }
  fx.seen = ids
  for (const [id, at] of fx.births) {
    if (nowMs - at > IGNITE_MS || !ids.has(id)) fx.births.delete(id)
  }
}

/**
 * Fold activity events into sparks. `memory-progress` rows carry {stage, slug?, ids?};
 * stage 'done' resolves the progress glow into a birth-style ignite on its ids.
 */
function noteEvents(canvas, events, nowMs) {
  const fx = fxOf(canvas)
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    // Same seq must not re-ignite: callers without a since-cursor used to replay the
    // whole feed and paint a soft blur-glow field every open.
    const seq = Number(e.seq) || 0
    if (seq > 0 && seq <= fx.lastEventSeq) continue
    if (e.type === 'memory-progress') {
      const slug = String(e.slug || '')
      const key = String(e.work || '') + ':' + (slug || String(e.stage || 'work'))
      if (e.stage === 'done') {
        fx.progress.delete(key)
        const ids = Array.isArray(e.ids) ? e.ids : slug ? ['wiki:' + slug] : []
        for (const id of ids) fx.births.set(String(id), nowMs)
      } else {
        fx.progress.set(key, { at: nowMs, stage: String(e.stage || ''), ids: (Array.isArray(e.ids) ? e.ids : slug ? ['wiki:' + slug] : []).map(String) })
      }
    } else if (e.type === 'intent') {
      fx.flashes.push({ at: nowMs, kind: e.action === 'silent' || e.action === 'defer' ? 'restraint' : 'act' })
      if (fx.flashes.length > 6) fx.flashes.shift()
    } else if (e.type === 'dream' || e.type === 'daily-diary') {
      for (const id of Array.isArray(e.ids) ? e.ids : []) fx.births.set(String(id), nowMs)
    }
    if (seq > 0) fx.lastEventSeq = Math.max(fx.lastEventSeq, seq)
  }
  for (const [key, p] of fx.progress) {
    if (nowMs - p.at > PROGRESS_TTL_MS) fx.progress.delete(key)
  }
  fx.flashes = fx.flashes.filter((f) => nowMs - f.at < FLASH_MS)
}

/** 0..1 birth envelope: fast rise, slow fade. */
function birthGlow(fx, id, nowMs) {
  const at = fx.births.get(id)
  if (at == null) return 0
  const t = (nowMs - at) / IGNITE_MS
  if (t < 0 || t > 1) return 0
  return t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85
}

/** Is any progress stage live right now (panel badge / window title)? */
function progressActive(canvas) {
  const fx = fxByCanvas.get(canvas)
  return !!(fx && fx.progress.size)
}

/**
 * Draw the process layer over the projected stars.
 * projected: [{x,y,node,near}], byId: Map, view for restraint flash placement.
 */
function drawProcess(ctx, canvas, projected, byId, nowMs, w, h) {
  const fx = fxByCanvas.get(canvas)
  if (!fx) return
  const TT = nowMs / 1000

  // Working glow: a breathing ring around each star the current stage touches.
  for (const p of fx.progress.values()) {
    for (const id of p.ids) {
      const rec = byId.get(id)
      if (!rec) continue
      const pulse = 0.5 + 0.5 * Math.sin(TT * 2.2)
      ctx.strokeStyle = 'rgba(126,232,250,' + (0.25 + 0.3 * pulse).toFixed(3) + ')'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(rec.x, rec.y, 10 + 5 * pulse, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Birth: the new star flares and its neighbours' light leans inward — dust gathering.
  for (const rec of projected) {
    const g = birthGlow(fx, rec.node.id, nowMs)
    if (g <= 0) continue
    const r = 6 + 26 * (1 - g)
    const grad = ctx.createRadialGradient(rec.x, rec.y, 0, rec.x, rec.y, r)
    grad.addColorStop(0, 'rgba(255,240,200,' + (0.5 * g).toFixed(3) + ')')
    grad.addColorStop(1, 'rgba(255,240,200,0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(rec.x, rec.y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Intent flashes: a soft ripple at the sky's heart. Restraint is cooler/dimmer than
  // action — a thought held back is still a thought, and the sky admits it quietly.
  for (const f of fx.flashes) {
    const t = (nowMs - f.at) / FLASH_MS
    if (t < 0 || t > 1) continue
    const r = 14 + 70 * t
    const alpha = (f.kind === 'restraint' ? 0.16 : 0.26) * (1 - t)
    const col = f.kind === 'restraint' ? '150,170,220' : '255,220,160'
    ctx.strokeStyle = 'rgba(' + col + ',' + alpha.toFixed(3) + ')'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

module.exports = { fxOf, noteGraph, noteEvents, drawProcess, birthGlow, progressActive, IGNITE_MS, FLASH_MS }