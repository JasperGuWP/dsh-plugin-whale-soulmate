// Orbit camera for the memory sea: drag to turn, wheel to zoom, click a star
// to pin it, double-click a star to fly to it, double-click space to come home.
// One view per canvas, kept in a WeakMap.
const DEFAULT_VIEW = {
  yaw: -0.35,
  pitch: 0.16,
  zoom: 1.05,
  // Pan is a screen-space offset applied after projection. Without it the camera could
  // only ever look at the world origin, so "zoom in on that memory" was impossible.
  panX: 0,
  panY: 0,
  pinned: null,
  hoverId: null,
  vy: 0,
  vp: 0,
  flying: null,
}
/**
 * Wheel zoom limits. The ceiling used to be 2.2 (then 6.5), which only spread the stars
 * apart — the dots themselves barely grew, so you never got *close* to a memory. 14 is
 * deep enough to read a single star, and `stepFly` targets 9 for a double-click landing.
 */
const MIN_ZOOM = 0.6
const MAX_ZOOM = 14
/** Zoom a double-click settles at. Deep, but leaves room to push further in. */
const FLY_ZOOM = 9
const neuronViews = new WeakMap()

function resetView(view) {
  view.yaw = DEFAULT_VIEW.yaw
  view.pitch = DEFAULT_VIEW.pitch
  view.zoom = 1
  view.panX = 0
  view.panY = 0
  view.pinned = null
  view.hoverId = null
  view.vy = 0
  view.vp = 0
  view.flying = null
}

function neuronViewOf(canvas) {
  let view = neuronViews.get(canvas)
  if (!view) {
    view = Object.assign({}, DEFAULT_VIEW)
    neuronViews.set(canvas, view)
    bindNeuronInput(canvas, view)
  }
  return view
}

/**
 * Hit-test the projected stars. Shared by hover, click-to-pin and double-click-to-fly so
 * all three agree on what "that star" means. Private nodes are never pickable.
 */
function pickNode(view, canvas, clientX, clientY, radius = 14) {
  const rect = canvas.getBoundingClientRect()
  const s = rect.width > 0 ? canvas.width / rect.width : 1
  const x = (clientX - rect.left) * s
  const y = (clientY - rect.top) * s
  // The pick radius is in screen pixels, so it has to grow with zoom or a close-up star
  // would need pixel-perfect aim.
  const r = radius * (s > 0 ? 1 : 1)
  let best = null
  let bestD = r * r
  for (const p of view.lastProjected || []) {
    if (p.node.kind === 'private_shielded') continue
    const dx = p.x - x
    const dy = p.y - y
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = p }
  }
  return best
}

/** Start flying to a memory. The animation is driven per frame by `stepFly`. */
function flyTo(view, nodeId) {
  if (!nodeId) return
  view.flying = { id: nodeId, zoom: FLY_ZOOM }
  view.pinned = nodeId
  view.vy = 0
  view.vp = 0
}

/**
 * One frame of the fly-to animation.
 *
 * `focusScreen` is where the target star currently projects to. The pan is corrected by
 * the *measured* offset rather than by solving for a fixed target, because zoom keeps
 * changing the projection while the flight is running — a precomputed pan would drift
 * off as soon as the star started growing. Re-reading the error each frame makes it
 * self-correcting and stable.
 *
 * Smoothing is time-based, not per-frame: `1 − exp(−dt/τ)` converges in about the same
 * wall-clock time at 60fps and at 10fps. A fixed fraction per frame looked fine on a
 * desktop and then crawled whenever the browser throttled the tab.
 *
 * @param {number} dtMs  elapsed since the previous frame
 * @returns {boolean} true while the flight is still in motion
 */
function stepFly(view, focusScreen, w, h, dtMs = 16.7) {
  const fly = view.flying
  if (!fly) return false
  // The memory was forgotten (or the graph reloaded) mid-flight: land without panicking.
  if (!focusScreen) { view.flying = null; return false }
  const dt = Math.min(120, Math.max(1, dtMs || 16.7))
  const kPan = 1 - Math.exp(-dt / 90)
  const kZoom = 1 - Math.exp(-dt / 110)
  const dx = w / 2 - focusScreen.x
  const dy = h / 2 - focusScreen.y
  view.panX = (view.panX || 0) + dx * kPan
  view.panY = (view.panY || 0) + dy * kPan
  const dz = fly.zoom - view.zoom
  view.zoom += dz * kZoom
  const settled = Math.abs(dx) < 0.8 && Math.abs(dy) < 0.8 && Math.abs(dz) < 0.02
  if (settled) {
    view.zoom = fly.zoom
    view.flying = null
    return false
  }
  return true
}

function bindNeuronInput(canvas, view) {
  let drag = null
  const down = (event) => {
    // Any manual drag takes the camera back from the animation, otherwise the two fight.
    view.flying = null
    drag = { x: event.clientX, y: event.clientY, moved: 0 }
    canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const move = (event) => {
    if (!drag) {
      const hit = pickNode(view, canvas, event.clientX, event.clientY, 14)
      view.hoverId = hit ? hit.node.id : null
      canvas.style.cursor = hit ? 'pointer' : 'grab'
      return
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    drag.moved += Math.abs(dx) + Math.abs(dy)
    view.yaw += dx * 0.005
    view.pitch = Math.min(1.25, Math.max(-1.25, view.pitch + dy * 0.004))
    view.vy = dx * 0.0012
    view.vp = dy * 0.001
  }
  const up = (event) => {
    const wasTap = drag && drag.moved < 5
    drag = null
    canvas.style.cursor = 'grab'
    if (wasTap) {
      const hit = pickNode(view, canvas, event.clientX, event.clientY, 14)
      view.pinned = hit && hit.node.id !== view.pinned ? hit.node.id : null
    }
  }
  const wheel = (event) => {
    event.preventDefault()
    // Zooming by hand cancels a flight in progress.
    view.flying = null
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * (event.deltaY > 0 ? 0.92 : 1.08)))
    const f = next / view.zoom
    if (f === 1) return
    // Zoom about the cursor, not the canvas centre. Projection is
    //   screen = centre + a·k + pan   (a = the rotated world point)
    // so keeping the point under the cursor fixed means
    //   pan' = pan + (cursor − centre − pan)·(1 − f)
    // The (cursor − centre − pan) term is exactly a·k, so this stays exact at any depth
    // without ever needing the world position. Without it, zooming in after a fly-to
    // drifted the pinned star straight off the canvas.
    const rect = canvas.getBoundingClientRect()
    const s = rect.width > 0 ? canvas.width / rect.width : 1
    const cx = canvas.width / 2
    const cy = canvas.height / 2
    const px = (event.clientX - rect.left) * s
    const py = (event.clientY - rect.top) * s
    view.panX = (view.panX || 0) + (px - cx - (view.panX || 0)) * (1 - f)
    view.panY = (view.panY || 0) + (py - cy - (view.panY || 0)) * (1 - f)
    view.zoom = next
  }
  const dblclick = (event) => {
    // Double-click a star to fly to it, double-click empty sky to come home. This lives
    // here rather than in the React page: the camera owns pointer and wheel already, and
    // the preview harness renders the same modules, so binding it here makes both work.
    const hit = pickNode(view, canvas, event.clientX, event.clientY, 18)
    if (hit) flyTo(view, hit.node.id)
    else resetView(view)
  }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('wheel', wheel, { passive: false })
  canvas.addEventListener('dblclick', dblclick)
}

/**
 * Perspective projector shared by stars and threads.
 *
 * `camZ` is the orbit distance. It used to be 96, i.e. nearly orthographic: the whole
 * memory sea spans ~73 world units, so depth only moved `k` by ±5% and every star looked
 * equidistant. Pulling it to 70 roughly triples the depth response while keeping the
 * framing intact, and `focal` is scaled by the same ratio so framing and the click
 * hit-testing stay as they were — distance is a perspective knob, not a zoom.
 */
const CAM_Z = 70
const BASE_CAM_Z = 96

function makeProjector(view, w, h) {
  const cyaw = Math.cos(view.yaw)
  const syaw = Math.sin(view.yaw)
  const cpitch = Math.cos(view.pitch)
  const spitch = Math.sin(view.pitch)
  const focal = Math.min(w, h) * 1.4 * view.zoom * (CAM_Z / BASE_CAM_Z)
  const camZ = CAM_Z
  const panX = view.panX || 0
  const panY = view.panY || 0
  return (p) => {
    const x1 = p.x * cyaw - p.z * syaw
    const z1 = p.x * syaw + p.z * cyaw
    const y1 = p.y * cpitch - z1 * spitch
    const z2 = p.y * spitch + z1 * cpitch
    const k = focal / (camZ + z2)
    return { x: w / 2 + x1 * k + panX, y: h / 2 + y1 * k + panY, z: z2, k }
  }
}

module.exports = {
  DEFAULT_VIEW, MIN_ZOOM, MAX_ZOOM, FLY_ZOOM, neuronViews, neuronViewOf,
  resetView, pickNode, flyTo, stepFly, makeProjector, CAM_Z,
}