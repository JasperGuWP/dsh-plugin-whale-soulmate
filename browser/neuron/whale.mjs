// Whale geometry template — the memory star-map is laid out AS this silhouette
// (a constellation). Side profile of a humpback/blue whale, nose to the right.
// Local units, y up, body length ≈ 2.7 units.
//
// Proportions follow a real whale rather than a cartoon fish:
//   · head ~28% of the length, blunt snout with a slight jaw bulge underneath
//   · back nearly flat, a low hump only at ~35% from the nose
//   · the body tapers hard into a thin caudal peduncle (tail stock ~0.16 tall)
//   · flukes fan out as two lobes from that peduncle, not as separate petals
//   · pectoral flipper is short (≈0.55) and sits low and forward

function cubic(p0, p1, p2, p3, n) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const mt = 1 - t
    out.push([
      mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return out
}
const seg = (list) => list.flat()

/**
 * Body: snout tip → rounded forehead → flat back → hump → thin tail stock → fluke
 * notch → belly → throat → back to snout. Traced clockwise from the snout.
 */
const BODY_PTS = seg([
  // snout: blunt, slightly below the forehead apex
  cubic([1.36, 0.10], [1.34, 0.26], [1.26, 0.34], [1.14, 0.37], 8).slice(0, -1),
  // forehead + back: a long, almost straight run with one soft hump
  cubic([1.14, 0.37], [0.98, 0.41], [0.80, 0.42], [0.60, 0.43], 8).slice(0, -1),
  cubic([0.60, 0.43], [0.42, 0.44], [0.26, 0.43], [0.10, 0.40], 8).slice(0, -1),
  // back falls away into the tail stock
  cubic([0.10, 0.40], [-0.16, 0.35], [-0.42, 0.26], [-0.62, 0.15], 8).slice(0, -1),
  // caudal peduncle: sharply narrowed
  cubic([-0.62, 0.15], [-0.74, 0.09], [-0.82, 0.05], [-0.88, 0.03], 5).slice(0, -1),
  // fluke notch (the fork between the two lobes)
  cubic([-0.88, 0.03], [-0.92, 0.01], [-0.94, -0.02], [-0.90, -0.05], 4).slice(0, -1),
  // underside of the peduncle, widening into the belly
  cubic([-0.90, -0.05], [-0.82, -0.07], [-0.72, -0.12], [-0.60, -0.19], 6).slice(0, -1),
  // belly: the deepest point sits around x≈0, then rises to the throat
  cubic([-0.60, -0.19], [-0.32, -0.34], [0.04, -0.40], [0.38, -0.38], 10).slice(0, -1),
  // throat + lower jaw, back up to the snout tip
  cubic([0.38, -0.38], [0.72, -0.35], [1.00, -0.26], [1.18, -0.12], 8).slice(0, -1),
  cubic([1.18, -0.12], [1.28, -0.04], [1.34, 0.03], [1.36, 0.10], 6).slice(0, -1),
])
const WHALE_OUTLINE = BODY_PTS

/** Pearl belly patch: throat grooves area, the pale underside of a real whale. */
const BELLY_PTS = seg([
  cubic([1.14, 0.02], [0.96, -0.06], [0.72, -0.10], [0.44, -0.12], 8).slice(0, -1),
  cubic([0.44, -0.12], [0.16, -0.14], [-0.14, -0.16], [-0.40, -0.18], 8).slice(0, -1),
  cubic([-0.40, -0.18], [-0.46, -0.24], [-0.48, -0.29], [-0.46, -0.32], 4).slice(0, -1),
  cubic([-0.46, -0.32], [-0.18, -0.40], [0.18, -0.40], [0.50, -0.36], 8).slice(0, -1),
  cubic([0.50, -0.36], [0.78, -0.32], [1.00, -0.22], [1.14, 0.02], 8).slice(0, -1),
])
/** Upper edge of the pearl band — episode crystals hang along it. */
const BELLY_LINE = seg([
  cubic([1.14, 0.02], [0.96, -0.06], [0.72, -0.10], [0.44, -0.12], 8).slice(0, -1),
  cubic([0.44, -0.12], [0.16, -0.14], [-0.14, -0.16], [-0.40, -0.18], 8),
])

/**
 * Fluke lobe: a swept blade that trails back almost horizontally and forks only
 * gently, the way a swimming whale's flukes read from the side. The previous lobe
 * splayed ±0.5 above and below the body line, which made the tail look like antlers.
 */
function fluke(sign, n = 16) {
  const out = []
  const edge = (t) => [
    -0.86 - (0.42 * t + 0.05 * t * t),
    0.01 + sign * (0.30 * t + 0.06 * t * t * t),
  ]
  const thick = (t) => 0.085 * Math.sin(Math.PI * Math.pow(t, 0.72)) * (1 - 0.55 * t)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const [x, y] = edge(t)
    out.push([x, y + sign * thick(t)])
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n
    const [x, y] = edge(t)
    out.push([x, y - sign * thick(t)])
  }
  return out
}
const FLUKE_UP = fluke(1)
const FLUKE_LEFT = fluke(-1)

/**
 * Pectoral flipper: long, narrow, swept back — a whale's is a wing, not a paddle.
 * Anchored low on the flank just behind the jaw.
 */
function flipper(ax, ay, length, width, spreadDeg, n = 14) {
  const a = (spreadDeg * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const nx = -dy
  const ny = dx
  const out = []
  const half = (t) => width * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 - 0.62 * t)
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const bend = 0.16 * t * t
    const cxp = ax + (dx - nx * bend) * length * t
    const cyp = ay + (dy - ny * bend) * length * t
    out.push([cxp + nx * half(t), cyp + ny * half(t)])
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n
    const bend = 0.16 * t * t
    const cxp = ax + (dx - nx * bend) * length * t
    const cyp = ay + (dy - ny * bend) * length * t
    out.push([cxp - nx * half(t), cyp - ny * half(t)])
  }
  return out
}
// near-side flipper (lower, fully visible) and the far-side one peeking out behind it
const FLIPPER = flipper(0.42, -0.30, 0.62, 0.105, 214)
const FLIPPER2 = flipper(0.06, -0.34, 0.46, 0.075, 218)

/** Low dorsal hump — a shark fin would read wrong on a whale. */
function hump(x0, y0, len, height, n = 10) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    out.push([x0 - len * t, y0 + height * Math.sin(Math.PI * Math.pow(t, 0.7)) * (1 - 0.25 * t)])
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n
    out.push([x0 - len * t, y0 + height * 0.22 * Math.sin(Math.PI * t)])
  }
  return out
}
const DORSAL = hump(0.16, 0.34, 0.30, 0.105)

function pointInPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]; const yi = poly[i][1]
    const xj = poly[j][0]; const yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function sampleEvery(pts, step) {
  const out = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i])
  return out
}

/** Bright accent sparkles, placed like the reference art's gold stars. */
const ACCENT_SLOTS = [
  [0.90, 0.22], [0.58, 0.20], [0.26, 0.14], [-0.06, 0.08], [-0.36, 0.02],
  [0.76, 0.04], [0.42, -0.02], [0.08, -0.08], [-0.24, -0.10], [0.56, -0.16],
  [-1.10, 0.62], [-1.24, -0.52], [0.20, -0.26], [-0.62, -0.02],
]

const WHALE_SLOTS = {
  outline: sampleEvery(BODY_PTS, 3),
  belly: sampleEvery(BELLY_LINE, 2),
  flukeUp: sampleEvery(FLUKE_UP, 2),
  flukeDown: sampleEvery(FLUKE_LEFT, 2),
  flipper: sampleEvery(FLIPPER, 2),
  flipper2: sampleEvery(FLIPPER2, 2),
  dorsal: sampleEvery(DORSAL, 2),
  accent: ACCENT_SLOTS,
}

/** Side-profile columns: spine, half-height and half-depth per x. */
const COLUMNS = (() => {
  const top = new Map()
  const bot = new Map()
  let minX = Infinity
  let minXi = 0
  BODY_PTS.forEach(([x, y], i) => { if (x < minX) { minX = x; minXi = i } })
  for (let i = 0; i <= minXi; i++) { const [x, y] = BODY_PTS[i]; const k = Math.round(x * 40); if (!top.has(k) || y > top.get(k)) top.set(k, y) }
  for (let i = minXi; i < BODY_PTS.length; i++) { const [x, y] = BODY_PTS[i]; const k = Math.round(x * 40); if (!bot.has(k) || y < bot.get(k)) bot.set(k, y) }
  return { top, bot }
})()
function bodyColumn(x) {
  const k = Math.round(x * 40)
  let t = COLUMNS.top.get(k)
  let b = COLUMNS.bot.get(k)
  if (t === undefined || b === undefined) {
    let kk = k
    while ((t === undefined || b === undefined) && kk < 60) { kk += 1; t = t === undefined ? COLUMNS.top.get(kk) : t; b = b === undefined ? COLUMNS.bot.get(kk) : b }
    kk = k
    while ((t === undefined || b === undefined) && kk > -60) { kk -= 1; t = t === undefined ? COLUMNS.top.get(kk) : t; b = b === undefined ? COLUMNS.bot.get(kk) : b }
  }
  if (t === undefined) t = 0.3
  if (b === undefined) b = -0.3
  const spine = (t + b) / 2
  const half = Math.max(0.06, (t - b) / 2)
  // Cross-section: nearly round, but a whale's flanks flatten slightly toward the
  // tail stock — the narrow peduncle must not get the depth of the mid-body.
  const squash = spine > 0.2 ? 0.86 : 0.94
  return { spine, half, Z: half * squash }
}

module.exports = {
  WHALE_OUTLINE, WHALE_SLOTS, pointInPoly, BELLY_LINE,
  BODY_PTS, BELLY_PTS, FLUKE_UP, FLUKE_LEFT, FLIPPER, FLIPPER2, DORSAL, bodyColumn,
}