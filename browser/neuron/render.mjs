// drawNeurons — the memory sea in one pass:
// deep sky → whale constellation strokes → synapse whispers → stars → vignette.
const { nodeTint } = require('./palette.mjs')
const { neuronSky, rebuildNeuronSky, drawSky, drawVignette } = require('./sky.mjs')
const { layoutMemoryGalaxy } = require('./constellation.mjs')
const { neuronViewOf, makeProjector, stepFly } = require('./camera.mjs')

const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

// Depth response. `near` is 0 for the deepest point of the body and 1 for the part
// nearest the camera, measured against the whale's own half-depth — a property of the
// geometry, not of whichever memories happen to exist. Normalising against the current
// node set instead gives two memories 0 and 1, so a nearly empty sky would swing between
// extremes every time the camera turned.
//
// This replaces a fixed `k / 2.2` divisor that could never work: k only ever spanned
// 4.8–6.4, so the ratio sat past the top of its clamp and every star drew at one size —
// the whole size cue, the strongest depth signal there is, was pinned flat.
const DEPTH_SPAN = 3
const NEAR_SIZE = 0.62
const NEAR_SIZE_GAIN = 1.25
const NEAR_FOG = 0.32
const nearOf = (z, halfDepth) => clampNum(0.5 - z / (2 * DEPTH_SPAN * halfDepth), 0, 1)

/**
 * Crowding falloff: on a dense sky the memory stars must read as dust suspended in the
 * night rather than a solid blue wash. The first attempt at this (core 0.46) was far too
 * aggressive — combined with `drawGrain` sending most nodes to 0.08 alpha, a 400-memory
 * sky lit only 5% of its pixels and looked black. These values dim the *crowd* without
 * making anything invisible, and the core never drops below half brightness.
 */
const CROWD_CORE = 0.72
const CROWD_HALO = 0.62
const CROWD_FLARE = 0.7

/**
 * Constellation star: bright core + white highlight + four-point flare.
 *
 * @param {number} zoom  camera zoom; star sizes grow with it so pushing in actually
 *   brings you closer to the memories instead of only spreading them apart
 */
function drawNode(ctx, p, t, focused, calm, zoom = 1) {
  const TT = t / 1000
  const node = p.node
  const tint = nodeTint(node.kind)
  const rgb = tint[0] + ',' + tint[1] + ',' + tint[2]
  const energy = clampNum(node.energy == null ? 0.5 : node.energy, 0, 1)
  const shielded = node.kind === 'private_shielded'
  const near = p.near == null ? 0.5 : p.near
  // Depth already scales the dot; zoom scales it again (damped, 1 → 7.8 at max zoom) so
  // "get close" reads as the memories themselves growing, not just the gaps widening.
  const zoomGain = 1 + (zoom - 1) * 0.52
  const u = (NEAR_SIZE + NEAR_SIZE_GAIN * near) * zoomGain
  const fog = NEAR_FOG + (1 - NEAR_FOG) * near
  const tw = 0.72 + 0.28 * Math.sin(TT * 1.6 + p.x * 0.05 + p.y * 0.07)
  const crowd = calm ? CROWD_CORE : 1

  // core = which layer, then salience *within* that layer. The previous formula
  // (0.55 + 0.26·importance) spanned 0.81→1.85px, i.e. under one pixel of difference
  // between a throwaway fact and a topic — every dot measured the same on screen.
  const imp = clampNum(node.importance == null ? 1 : node.importance, 1, 5)
  const salience = (imp - 1) / 4
  // A memory's size must say *which layer it belongs to* before it says anything else.
  // Previously size came from `importance` alone, and that silently flattened the
  // hierarchy: `buildNeuralGraph` gives topics importance 5, but a retained fact also
  // reaches 5. Measured on a layered graph — wiki_star importance 5, fact_neuron
  // importance 1..5 — the inputs were identical, so a throwaway fact drew exactly as large
  // as a theme star and the three layers were invisible. Each layer now owns its own size
  // band and importance only ranks stars *within* their band.
  const LAYER_BAND = {
    wiki_star: [3.3, 5.2],        // the gold suns
    episode_crystal: [1.4, 2.4],  // diary crystals
    session_star: [1.55, 2.7],    // chat-session stars — slightly larger/warmer than diary
    fact_neuron: [0.7, 1.9],      // the blue dust
    private_shielded: [0.9, 1.7],
  }
  const band = LAYER_BAND[node.kind] || LAYER_BAND.fact_neuron
  const rank = Math.pow(salience, 0.7)
  // Floor raised to 0.75: at 0.45 a minor fact was a sub-pixel speck that vanished once
  // the canvas was shown at panel size (~0.55 scale).
  // Ceiling follows the zoom: a flat 5px cap meant that past ~4× the biggest stars stopped
  // growing while merely drifting apart, which is what made zooming feel like scrolling.
  const cr = clampNum((band[0] + (band[1] - band[0]) * rank) * u, 0.75, 11 * zoomGain)

  // halo = layer + freshness. Topic stars get a generous corona, facts almost none: a
  // glow on every speck was what made the hierarchy read as one flat field of dots.
  const haloGain = node.kind === 'wiki_star' ? 1
    : node.kind === 'session_star' ? 0.62
    : node.kind === 'episode_crystal' ? 0.55
    : 0.34
  const wantHalo = !calm || shielded === false && (node.kind === 'wiki_star' || focused)
  const hr = clampNum(cr * (2.6 + 1.6 * energy), 1.4, 13 * zoomGain) * (shielded ? 0.7 : 1) * haloGain
  const ha = (0.10 + 0.20 * energy) * tw * (shielded ? 0.5 : 1) * (wantHalo ? 1 : 0) * fog * (calm ? CROWD_HALO : 1) * 0.8 * haloGain
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr)
  g.addColorStop(0, 'rgba(' + rgb + ',' + ha.toFixed(3) + ')')
  g.addColorStop(1, 'rgba(' + rgb + ',0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(p.x, p.y, hr, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(' + rgb + ',' + ((shielded ? 0.55 : 0.95) * fog * crowd).toFixed(3) + ')'
  ctx.beginPath()
  ctx.arc(p.x, p.y, cr, 0, Math.PI * 2)
  ctx.fill()

  // White core: the tiny hot centre that makes a dot read as a *star* rather than a
  // coloured disc. It deliberately ignores `crowd` (a highlight is not "more memory
  // light") and only takes a mild haze towards the far side — folding `fog*crowd` in
  // here made it 0.08 alpha, i.e. invisible, which is why a pixel scan found no white at
  // all. Salience still sizes it, so a topic has a bigger hot centre than a minor fact.
  if (!shielded) {
    const white = 0.5 + 0.45 * salience
    const wr = clampNum(cr * (0.34 + 0.26 * salience), 0.4, cr * 0.66)
    const haze = 0.45 + 0.55 * near
    const wg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, wr)
    wg.addColorStop(0, 'rgba(255,255,255,' + clampNum(white * haze, 0, 1).toFixed(3) + ')')
    wg.addColorStop(0.5, 'rgba(255,255,255,' + clampNum(white * 0.6 * haze, 0, 1).toFixed(3) + ')')
    wg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = wg
    ctx.beginPath()
    ctx.arc(p.x, p.y, wr, 0, Math.PI * 2)
    ctx.fill()
  }

  // four-point constellation flare (crowded skies: only the truly bright)
  const wantFlare = !shielded && (!calm || node.kind === 'wiki_star' || focused || (node.importance || 0) >= 5)
  if (wantFlare) {
    const len = cr * (2.2 + 0.7 * Math.min(5, node.importance || 1)) * tw
    ctx.strokeStyle = 'rgba(' + rgb + ',' + ((calm ? 0.28 : 0.40) * tw * fog * (calm ? CROWD_FLARE : 1)).toFixed(3) + ')'
    ctx.lineWidth = 0.55 + 0.35 * u
    ctx.beginPath()
    ctx.moveTo(p.x - len, p.y); ctx.lineTo(p.x + len, p.y)
    ctx.moveTo(p.x, p.y - len); ctx.lineTo(p.x, p.y + len)
    ctx.stroke()
  }

  if (focused) {
    ctx.strokeStyle = 'rgba(' + rgb + ',0.65)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, cr + 4.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = 'rgba(226,236,255,0.88)'
    ctx.fillText(String(node.label || node.id), p.x + 9, p.y - 7)
  }
}

// `drawGrain` used to live here: a 0.08-alpha mote for every memory below importance 4.
// It has been removed together with the split that fed it — every memory is now a star,
// and hiding most of the graph was what made a busy sky look empty.

function drawNeurons(canvas, graph, t) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  // A canvas that has not been laid out yet reports 0×0; rebuilding the sky at that size
  // would bake an empty star table that then survives until a resize event.
  if (!(w > 0) || !(h > 0)) return
  if (neuronSky.w !== w || neuronSky.h !== h) rebuildNeuronSky(w, h)
  const view = neuronViewOf(canvas)

  // coasting inertia after a drag
  if (view.vy || view.vp) {
    view.yaw += view.vy
    view.pitch = clampNum(view.pitch + view.vp, -1.25, 1.25)
    view.vy *= 0.92
    view.vp *= 0.92
    if (Math.abs(view.vy) < 0.0002) view.vy = 0
    if (Math.abs(view.vp) < 0.0002) view.vp = 0
  }

  // Fly-to animation (double-click a star). It has to run *before* the sky is drawn: each
  // step nudges the pan, and the projection used for this frame must already include that
  // nudge or the star would trail one frame behind the movement.
  if (view.flying) {
    const target = view.lastProjected && view.lastProjected.find((p) => p.node.id === view.flying.id)
    stepFly(view, target, w, h, t - (view.lastT == null ? t - 16.7 : view.lastT))
  }
  view.lastT = t

  drawSky(ctx, w, h, t, view)
  const projectTo = makeProjector(view, w, h)
  const TT = t / 1000

  const layout = layoutMemoryGalaxy(graph)
  const nodes = ((graph && graph.nodes) || []).slice(0, 240)
  const projected = []
  const byId = new Map()
  const halfDepth = layout.halfDepth || 8
  for (const node of nodes) {
    if (!node) continue
    const pos = layout.world.get(node.id) || node.position
    if (!pos) continue
    const s = projectTo(pos)
    const rec = { x: s.x, y: s.y, z: s.z, k: s.k, near: nearOf(s.z, halfDepth), node }
    projected.push(rec)
    byId.set(node.id, rec)
  }
  view.lastProjected = projected

  // Only the memories' own links are drawn below. The whale's outline skeleton and the
  // placeholder guide dots are gone for good: they were never memory-to-memory links, so
  // they read as lines that meant nothing.
  const links = (graph && graph.synapses) || []
  // topic nebulae: one soft cloud per wiki star, sized by its cluster
  const deg = new Map()
  for (const link of links) {
    if (byId.has(link.target) && byId.get(link.target).node.kind === 'wiki_star') deg.set(link.target, (deg.get(link.target) || 0) + 1)
    if (byId.has(link.source) && byId.get(link.source).node.kind === 'wiki_star') deg.set(link.source, (deg.get(link.source) || 0) + 1)
  }
  for (const p of projected) {
    if (p.node.kind !== 'wiki_star') continue
    const d = deg.get(p.node.id) || 1
    const u = NEAR_SIZE + NEAR_SIZE_GAIN * p.near
    const hr = clampNum((12 + 2.6 * Math.sqrt(d)) * u, 12, 52)
    const g2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr)
    g2.addColorStop(0, 'rgba(255,213,148,0.065)')
    g2.addColorStop(0.6, 'rgba(180,205,255,0.030)')
    g2.addColorStop(1, 'rgba(180,205,255,0)')
    ctx.fillStyle = g2
    ctx.beginPath()
    ctx.arc(p.x, p.y, hr, 0, Math.PI * 2)
    ctx.fill()
  }

  // synapse whispers: the only lines on screen, and every one of them joins two real
  // memories. Drawn between the actual projected nodes, so a line never appears unless
  // both of its endpoints exist.
  const focusId = view.hoverId || view.pinned
  // Line width compensates for zoom: at 6× a fixed 0.6px stroke became a 4px cable that
  // buried the dots it connected.
  const lineScale = 1 / Math.max(1, view.zoom * 0.55)
  ctx.lineWidth = 0.6
  for (const link of links) {
    const a = byId.get(link.source)
    const b = byId.get(link.target)
    if (!a || !b) continue
    const touched = focusId && (link.source === focusId || link.target === focusId)
    const base = projected.length > 300 ? 0.02 + 0.025 * clampNum(link.strength || 0.5, 0, 1) : 0.04 + 0.04 * clampNum(link.strength || 0.5, 0, 1)
    const ndLink = nearOf((a.z + b.z) / 2, halfDepth)
    const alpha = touched ? 0.24 + 0.08 * Math.sin(TT * 2.4) : base * (0.35 + 0.85 * ndLink)
    ctx.strokeStyle = 'rgba(168,200,255,' + alpha.toFixed(3) + ')'
    ctx.lineWidth = 0.6 * lineScale
    const mx = (a.x + b.x) / 2 + (w / 2 - (a.x + b.x) / 2) * 0.10
    const my = (a.y + b.y) / 2 + (h / 2 - (a.y + b.y) / 2) * 0.10
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(mx, my, b.x, b.y)
    ctx.stroke()
  }

  // far → near. Every memory is drawn as a real star: the old split sent everything
  // below importance 4 into `drawGrain`, whose 0.08 alpha made the majority of the graph
  // literally invisible — measured at 5% lit pixels on a 400-memory sky. Salience still
  // separates them (importance drives core size and flare), it just no longer hides them.
  const order = projected.slice().sort((a, b) => b.z - a.z)
  for (const p of order) {
    const node = p.node
    const dense = projected.length > 300
    drawNode(ctx, p, t, node.id === focusId, dense, view.zoom)
  }

  drawVignette(ctx, w, h)
}

module.exports = { drawNeurons, drawNode }
