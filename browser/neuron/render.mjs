// drawNeurons — the memory sea in one pass:
// deep sky → whale constellation strokes → synapse whispers → stars → vignette.
const { nodeTint } = require('./palette.mjs')
const { neuronSky, rebuildNeuronSky, drawSky, drawVignette } = require('./sky.mjs')
const { layoutMemoryGalaxy } = require('./constellation.mjs')
const { neuronViewOf, makeProjector, stepFly, fitOverviewZoom } = require('./camera.mjs')
const { noteGraph, drawProcess } = require('./process.mjs')

const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

// '#4facfe' → '79,172,254'; anything else → null (caller falls back to the default blue).
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return null
  const n = parseInt(m[1], 16)
  return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255)
}
// Stable small hash for per-link pulse phase offsets.
function hashId(s) {
  let h = 0
  const t = String(s || '')
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return h
}

// Memory dust gets a small cool palette instead of one printed blue: different themes
// should read as different tints at a glance. Bright stars stand out by *shape* too.
const FACT_TINTS = [
  [158, 196, 255], // azure
  [120, 214, 232], // cyan
  [176, 166, 255], // periwinkle
  [126, 226, 196], // teal
  [196, 170, 250], // lilac
  [145, 210, 255], // ice
]
function starTint(node) {
  if (node.kind === 'fact_neuron' || node.kind === 'milestone_spark') {
    return FACT_TINTS[hashId(node.id) % FACT_TINTS.length]
  }
  // Dream pages are diaries in the outer band — cool ice, not theme gold.
  if (node.kind === 'wiki_star' && String(node.id).startsWith('wiki:dream-')) return [150, 205, 255]
  return nodeTint(node.kind)
}

/** Four-point star silhouette — bright memories should not all be circles. */
function sparklePath(ctx, x, y, outer, inner) {
  ctx.beginPath()
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    const px = x + Math.cos(a) * r
    const py = y + Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

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
function drawNode(ctx, p, t, focused, calm, zoom = 1, reducedMotion = false, overview = false) {
  const TT = t / 1000
  const node = p.node
  // Fine temperature variation per star: identical tints across dozens of facts read
  // as printed dots; a ±18 shift on red/blue gives the field a photographic feel.
  const warm = ((hashId(node.id) % 100) / 100) * 2 - 1
  const baseTint = starTint(node)
  const tint = [
    clampNum(baseTint[0] + warm * 18, 0, 255),
    clampNum(baseTint[1] + warm * 3, 0, 255),
    clampNum(baseTint[2] - warm * 14, 0, 255),
  ]
  const rgb = Math.round(tint[0]) + ',' + Math.round(tint[1]) + ',' + Math.round(tint[2])
  const energy = clampNum(node.energy == null ? 0.5 : node.energy, 0, 1)
  const shielded = node.kind === 'private_shielded'
  const near = p.near == null ? 0.5 : p.near
  // Depth already scales the dot; zoom scales it again (damped, 1 → 7.8 at max zoom) so
  // "get close" reads as the memories themselves growing, not just the gaps widening.
  const zoomGain = 1 + (zoom - 1) * 0.52
  const u = (NEAR_SIZE + NEAR_SIZE_GAIN * near) * zoomGain
  const fog = NEAR_FOG + (1 - NEAR_FOG) * near
  // Idle twinkle used to sit in ±14% — below the "is this moving?" threshold on a still
  // screenshot and at a glance. Wider envelope keeps hierarchy readable while the field
  // visibly breathes; prefers-reduced-motion collapses to a steady core.
  const tw = reducedMotion ? 0.85 : (0.52 + 0.48 * Math.sin(TT * 1.85 + p.x * 0.05 + p.y * 0.07))
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
    transcript_star: [1.3, 2.2],  // verbatim transcripts — quiet cool stars
    fact_neuron: [0.7, 1.9],      // the blue dust
    private_shielded: [0.9, 1.7],
  }
  let band = LAYER_BAND[node.kind] || LAYER_BAND.fact_neuron
  // Overview (card / default orbit): pull gold suns forward and hush dust so the
  // silhouette reads as a constellation, not a central blot of equal dots.
  if (overview) {
    if (node.kind === 'wiki_star') band = [band[0] * 1.22, band[1] * 1.28]
    else if (node.kind === 'session_star') band = [band[0] * 1.08, band[1] * 1.12]
    else if (node.kind === 'fact_neuron' || node.kind === 'milestone_spark') {
      band = [band[0] * 0.78, band[1] * 0.84]
    }
  }
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
  // Ambient bloom under every star: a wide, very soft breath of the star's own colour.
  // This is what makes the field read as light in a sky instead of stickers on black.
  const bloomR = clampNum(cr * (5.5 + 3.2 * energy), 3, 26 * zoomGain)
  const bloomA = (0.030 + 0.055 * energy) * tw * fog * (shielded ? 0.6 : 1) * (calm ? 0.72 : 1)
  const bg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, bloomR)
  bg.addColorStop(0, 'rgba(' + rgb + ',' + bloomA.toFixed(3) + ')')
  bg.addColorStop(0.55, 'rgba(' + rgb + ',' + (bloomA * 0.45).toFixed(3) + ')')
  bg.addColorStop(1, 'rgba(' + rgb + ',0)')
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.arc(p.x, p.y, bloomR, 0, Math.PI * 2)
  ctx.fill()
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr)
  g.addColorStop(0, 'rgba(' + rgb + ',' + ha.toFixed(3) + ')')
  g.addColorStop(1, 'rgba(' + rgb + ',0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(p.x, p.y, hr, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(' + rgb + ',' + ((shielded ? 0.55 : 0.95) * fog * crowd).toFixed(3) + ')'
  const shaped = !shielded && (
    node.kind === 'wiki_star' || node.kind === 'session_star' ||
    (node.kind === 'episode_crystal' && cr > 2) ||
    (node.kind === 'transcript_star' && cr > 1.6) || focused
  )
  if (shaped) {
    sparklePath(ctx, p.x, p.y, cr * 1.2, cr * 0.55)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.arc(p.x, p.y, cr, 0, Math.PI * 2)
    ctx.fill()
  }

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
  // Flares belong to stars that are actually bright: giving every dust mote a
  // four-point cross turned clusters into trails of little dashes.
  const wantFlare = !shielded && (node.kind === 'wiki_star' || node.kind === 'session_star' || focused || cr >= 2.4)
  if (wantFlare) {
    const len = cr * (2.0 + 0.7 * Math.min(5, node.importance || 1)) * tw
    const flareA = (calm ? 0.30 : 0.45) * tw * fog * (calm ? CROWD_FLARE : 1)
    ctx.strokeStyle = 'rgba(' + rgb + ',' + flareA.toFixed(3) + ')'
    ctx.lineWidth = 0.6 + 0.35 * u
    ctx.beginPath()
    ctx.moveTo(p.x - len, p.y); ctx.lineTo(p.x + len, p.y)
    ctx.moveTo(p.x, p.y - len); ctx.lineTo(p.x, p.y + len)
    ctx.stroke()
    // diagonal secondary spikes — the diamond sparkle of a real bright star
    if (node.kind === 'wiki_star' || node.kind === 'session_star' || focused) {
      const d2 = len * 0.42
      ctx.strokeStyle = 'rgba(255,255,255,' + (flareA * 0.5).toFixed(3) + ')'
      ctx.lineWidth = 0.5
      const dd = d2 * 0.7071
      ctx.beginPath()
      ctx.moveTo(p.x - dd, p.y - dd); ctx.lineTo(p.x + dd, p.y + dd)
      ctx.moveTo(p.x - dd, p.y + dd); ctx.lineTo(p.x + dd, p.y - dd)
      ctx.stroke()
    }
  }

  if (focused) {
    ctx.strokeStyle = 'rgba(' + rgb + ',0.65)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, cr + 4.5, 0, Math.PI * 2)
    ctx.stroke()
    drawInfoCard(ctx, p, node)
  }
}

// Focus card: type / age / recall count / one-line summary. A memory you can *read*
// is a memory that feels lived-in — the old single 10px label said almost nothing.
const KIND_LABEL = {
  wiki_star: '主题恒星',
  episode_crystal: '日记水晶',
  session_star: '会话窗星',
  fact_neuron: '记忆',
  milestone_spark: '里程碑',
  memento_relic: '纪念物',
  private_shielded: '私密',
}
function ageText(iso, t) {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return ''
  const days = Math.max(0, Math.floor((Date.now() - at) / 86400000))
  if (days === 0) return '今天记下'
  if (days < 30) return days + ' 天前记下'
  return Math.floor(days / 30) + ' 个月前记下'
}
function drawInfoCard(ctx, p, node) {
  const lines = []
  const title = String(node.label || node.id)
  lines.push({ text: title.length > 22 ? title.slice(0, 21) + '…' : title, bold: true })
  const meta = [KIND_LABEL[node.kind] || '记忆', ageText(node.createdAt || node.updatedAt),
    Number(node.recallCount) > 0 ? '被想起 ' + node.recallCount + ' 次' : ''].filter(Boolean).join(' · ')
  if (meta) lines.push({ text: meta })
  const summary = String(node.summary || '').replace(/\s+/g, ' ').trim()
  if (summary) lines.push({ text: summary.length > 26 ? summary.slice(0, 25) + '…' : summary })
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  let wMax = 0
  for (const l of lines) wMax = Math.max(wMax, ctx.measureText(l.text).width)
  const padX = 8, padY = 6, lh = 14
  const cw = wMax + padX * 2
  const ch = lines.length * lh + padY * 2
  let cx = p.x + 12
  let cy = p.y - ch - 8
  const W = ctx.canvas.width, H = ctx.canvas.height
  if (cx + cw > W - 6) cx = p.x - cw - 12
  if (cx < 6) cx = 6
  if (cy < 6) cy = p.y + 12
  if (cy + ch > H - 6) cy = H - ch - 6
  ctx.fillStyle = 'rgba(10,14,26,0.82)'
  ctx.strokeStyle = 'rgba(168,200,255,0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect ? ctx.roundRect(cx, cy, cw, ch, 6) : ctx.rect(cx, cy, cw, ch)
  ctx.fill()
  ctx.stroke()
  lines.forEach((l, i) => {
    ctx.fillStyle = l.bold ? 'rgba(236,242,255,0.95)' : 'rgba(196,210,240,0.8)'
    ctx.font = (l.bold ? '600 ' : '') + '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(l.text, cx + padX, cy + padY + 10 + i * lh)
  })
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
  const dtMs = Math.min(120, Math.max(1, t - (view.lastT == null ? t - 16.7 : view.lastT)))
  const reducedMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches

  // coasting inertia after a drag
  if (view.vy || view.vp) {
    view.yaw += view.vy
    view.pitch = clampNum(view.pitch + view.vp, -1.25, 1.25)
    view.vy *= 0.92
    view.vp *= 0.92
    if (Math.abs(view.vy) < 0.0002) view.vy = 0
    if (Math.abs(view.vp) < 0.0002) view.vp = 0
  }

  // Idle drift: empty sky should still breathe. Skip while flying, while the user is
  // still coasting, or when the OS asks for reduced motion.
  if (!reducedMotion && !view.flying && Math.abs(view.vy) < 0.0005 && Math.abs(view.vp) < 0.0005) {
    view.yaw += 0.000055 * dtMs
  }

  // Fly-to animation (double-click a star). It has to run *before* the sky is drawn: each
  // step nudges the pan, and the projection used for this frame must already include that
  // nudge or the star would trail one frame behind the movement.
  if (view.flying) {
    const target = view.lastProjected && view.lastProjected.find((p) => p.node.id === view.flying.id)
    stepFly(view, target, w, h, dtMs)
  }
  view.lastT = t

  drawSky(ctx, w, h, t, view)
  const projectTo = makeProjector(view, w, h)
  const TT = t / 1000

  const layout = layoutMemoryGalaxy(graph)

  // Auto-frame the living sky into the canvas. Skip once the user has dragged/zoomed,
  // or while a fly-to / pin is active — those own the camera.
  if (!view.userFramed && !view.flying && !view.pinned) {
    const want = fitOverviewZoom(layout.coreExtent || layout.extent, w, h)
    const dz = want - view.zoom
    if (Math.abs(dz) > 0.035) view.zoom += dz * 0.14
    else view.zoom = want
  }
  const overview = view.zoom < 2.55

  // The old flat slice(0, 240) silently deleted old memories from the sky — exactly the
  // ones a growth trajectory needs. Rank by importance+energy instead, and let the cap
  // grow with zoom: pushing in earns more stars, overview stays readable.
  const allNodes = (graph && graph.nodes) || []
  const cap = Math.min(900, Math.round(240 + (view.zoom - 1) * 60))
  const nodes = allNodes.length <= cap ? allNodes : allNodes.slice().sort((a, b) =>
    ((b.importance || 1) + (b.energy || 0.5) * 2) - ((a.importance || 1) + (a.energy || 0.5) * 2)
  ).slice(0, cap)
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
    const hr = clampNum((12 + 2.6 * Math.sqrt(d)) * u * (overview ? 1.15 : 1), 12, 58)
    const g2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr)
    const coreA = overview ? 0.095 : 0.065
    g2.addColorStop(0, 'rgba(255,213,148,' + coreA.toFixed(3) + ')')
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
  const denseSky = projected.length > 300
  // Line width compensates for zoom: at 6× a fixed 0.6px stroke became a 4px cable that
  // buried the dots it connected.
  const lineScale = 1 / Math.max(1, view.zoom * 0.55)
  ctx.lineWidth = 0.6
  for (const link of links) {
    const a = byId.get(link.source)
    const b = byId.get(link.target)
    if (!a || !b) continue
    const touched = focusId && (link.source === focusId || link.target === focusId)
    const s = clampNum(link.strength || 0.5, 0, 1)
    // Old alpha topped out near 0.08 — on the panel-sized dark canvas the whole network
    // was effectively invisible. Lines now carry their kind colour and enough weight to
    // read as connections, while a faint wide under-stroke gives them a soft glow.
    // Cloud-sync beams are the exception: dozens of them cut straight across every
    // local cluster, so they render as a whisper (or not at all while untouched).
    const isBeam = link.kind === 'warp_sync_beam'
    const isDream = (id) => {
      const rec = byId.get(id)
      return !!(rec && rec.node.kind === 'wiki_star' && String(id).startsWith('wiki:dream-'))
    }
    // Dreams no longer own facts: the old fact→dream links still exist in the graph but
    // their endpoints sit in different bands now, so drawing them only adds cables.
    const dreamLink = link.kind === 'topic_cluster' && (isDream(link.source) || isDream(link.target))
    const base0 = denseSky ? 0.05 + 0.06 * s : 0.12 + 0.15 * s
    const base = isBeam ? base0 * 0.16 : base0
    const ndLink = nearOf((a.z + b.z) / 2, halfDepth)
    const alpha = touched ? 0.42 + 0.10 * Math.sin(TT * 2.4) : base * (0.5 + 0.5 * ndLink)
    const rgbLink = hexToRgb(link.pulseColor) || '168,200,255'
    const distPx = Math.hypot(b.x - a.x, b.y - a.y)
    const farLink = distPx > Math.max(w, h) * 0.30
    const midLink = distPx > Math.max(w, h) * 0.16
    // Short cluster links draw straight: bowed curves between neighbours read as
    // comet crescents around the sun, which is exactly the ugly artefact to avoid.
    const shortLink = distPx < Math.max(w, h) * 0.06
    const pull = shortLink ? 0 : 0.10
    const mx = (a.x + b.x) / 2 + (w / 2 - (a.x + b.x) / 2) * pull
    const my = (a.y + b.y) / 2 + (h / 2 - (a.y + b.y) / 2) * pull
    // Structure that spans the sky reads as stray cables, not as connection. Until the
    // user focuses one of its endpoints it is not drawn at all.
    if (!touched && (isBeam || dreamLink || farLink)) continue
    // Overview: keep only short/cluster spines — mid arcs turn the card into a hairball.
    if (!touched && overview && (midLink || (link.strength || 0) < 0.34)) continue
    const aFinal = touched ? alpha : midLink ? alpha * 0.45 : alpha
    if (!denseSky && !isBeam && !farLink && !shortLink) {
      ctx.strokeStyle = 'rgba(' + rgbLink + ',' + (alpha * 0.10).toFixed(3) + ')'
      ctx.lineWidth = 1.4 * lineScale
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.quadraticCurveTo(mx, my, b.x, b.y)
      ctx.stroke()
    }
    if (isBeam) ctx.setLineDash([4, 7])
    ctx.strokeStyle = 'rgba(' + rgbLink + ',' + aFinal.toFixed(3) + ')'
    ctx.lineWidth = (touched ? 1.1 : 0.8) * lineScale
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(mx, my, b.x, b.y)
    ctx.stroke()
    if (isBeam) ctx.setLineDash([])

    // Synapse pulse: a light mote travels the curve. Short cluster links get a quieter
    // mote so the overview still feels alive without turning into a strobe; dense skies
    // stay calm (readable dust, not fireworks).
    if (!reducedMotion && !denseSky && !isBeam && (link.strength || 0) >= 0.22) {
      const speed = 0.10 + 0.16 * clampNum(link.strength || 0.5, 0, 1)
      const phase = ((TT * speed) + (hashId(link.id) % 100) / 100) % 1
      const it = 1 - phase
      const px = it * it * a.x + 2 * it * phase * mx + phase * phase * b.x
      const py = it * it * a.y + 2 * it * phase * my + phase * phase * b.y
      const pc = hexToRgb(link.pulseColor) || '168,200,255'
      const quiet = shortLink ? 0.55 : 1
      const pa = (touched ? 0.7 : 0.4) * (0.35 + 0.65 * ndLink) * quiet
      ctx.fillStyle = 'rgba(' + pc + ',' + pa.toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(px, py, (touched ? 1.4 : 0.9) * lineScale * 2 * (shortLink ? 0.75 : 1), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // far → near. Every memory is drawn as a real star: the old split sent everything
  // below importance 4 into `drawGrain`, whose 0.08 alpha made the majority of the graph
  // literally invisible — measured at 5% lit pixels on a 400-memory sky. Salience still
  // separates them (importance drives core size and flare), it just no longer hides them.
  const order = projected.slice().sort((a, b) => b.z - a.z)
  for (const p of order) {
    const node = p.node
    const dense = projected.length > 300
    drawNode(ctx, p, t, node.id === focusId, dense, view.zoom, reducedMotion, overview)
  }

  // Process layer: births ignite, working stars breathe, intent ripples. Graph diff is
  // keyed on identity — a poll that returns the same sky adds nothing.
  noteGraph(canvas, graph, Date.now())
  drawProcess(ctx, canvas, projected, byId, Date.now(), w, h)

  // The locked corner: shielded memories keep their shape, never their content. A quiet
  // labelled arc says "her secrets live here" and points at the notebook, not the data.
  const shieldedCount = allNodes.filter((n) => n && n.kind === 'private_shielded').length
  if (shieldedCount > 0) {
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = 'rgba(150,170,220,0.5)'
    ctx.fillText('上锁的角落 · ' + shieldedCount + ' 条 · 内容在小本本', 10, h - 12)
  }

  drawVignette(ctx, w, h)
}

module.exports = { drawNeurons, drawNode }
