// Layout of the memory galaxy — a real sky, not a drawing.
//
// Topics (`wiki_star`, gold) are spread evenly across a wide shell so no two of them
// collide, and every fact orbits the topic it actually belongs to: the blue dots form a
// small cloud *around* their gold sun rather than all piling into one clump. Episodes get
// their own outer band. Nothing here traces a silhouette and nothing invents filler
// points — the shape on screen is whatever the memories are.
//
// Everything is deterministic from node ids and counts, so the sky never reshuffles
// between renders or after a reload.

/** Topic shell radius grows with the number of topics, but saturates. */
const TOPIC_SHELL_MIN = 9
const TOPIC_SHELL_GAIN = 2.0
const TOPIC_SHELL_MAX = 24
/** Fact cloud radius around its topic: small clusters stay tight, big ones spread. */
const CLOUD_MIN = 1.6
const CLOUD_GAIN = 0.9
const CLOUD_MAX = 6.2
const EPISODE_SHELL = 11
const PRIVATE_DISTANCE = 34

const hash01 = (i) => (((i * 2654435761) >>> 0) % 1000) / 1000

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Radius of the gold shell for `n` topics. */
function topicShell(n) {
  return clamp(TOPIC_SHELL_MIN + TOPIC_SHELL_GAIN * Math.sqrt(Math.max(1, n)), TOPIC_SHELL_MIN, TOPIC_SHELL_MAX)
}

/** Radius of the fact cloud for `k` facts hanging off one topic. */
function cloudShell(k) {
  return clamp(CLOUD_MIN + CLOUD_GAIN * Math.sqrt(Math.max(1, k)), CLOUD_MIN, CLOUD_MAX)
}

const layouts = new WeakMap()
/** Empty layout for a null/graphless canvas. `world` must be fresh per call: sharing one
 * Map would let two renders mutate each other's positions. */
const emptyLayout = () => ({ world: new Map(), halfDepth: 1, extent: 3 })

/** Deterministic layout of a neural graph as a scattered memory galaxy. */
function layoutMemoryGalaxy(graph) {
  // A WeakMap needs an object key. `graph` is legitimately null before the first engine
  // poll lands (and on a fresh install with no memories), so returning an empty layout is
  // the only thing that keeps the rAF loop alive — otherwise every frame throws on the
  // WeakMap lookup and the tab stays a black rectangle forever.
  if (!graph || typeof graph !== 'object') return emptyLayout()
  const cached = layouts.get(graph)
  if (cached) return cached

  const nodes = (graph && graph.nodes) || []
  const links = (graph && graph.synapses) || []
  const world = new Map()

  const topics = nodes.filter((n) => n && n.kind === 'wiki_star')
  const facts = nodes.filter((n) => n && n.kind === 'fact_neuron')
  const episodes = nodes.filter((n) => n && n.kind === 'episode_crystal')
  const sessionStars = nodes.filter((n) => n && n.kind === 'session_star')
  const transcripts = nodes.filter((n) => n && n.kind === 'transcript_star')
  const shielded = nodes.filter((n) => n && n.kind === 'private_shielded')
  const others = nodes.filter((n) => n && !['wiki_star', 'fact_neuron', 'episode_crystal', 'session_star', 'transcript_star', 'private_shielded'].includes(n.kind))

  // Dream pages are diaries, not themes (a sky of "soulmate的梦" gold suns reads as
  // clutter), and they never own children: the facts came first, the dream was written
  // *from* them. Themes keep the spiral arms.
  const dreamTopics = topics.filter((n) => String(n.id).startsWith('wiki:dream-') || /梦/.test(String(n.label || '')))
  const themeTopics = topics
    .filter((n) => !dreamTopics.includes(n))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
  const themeIds = new Map(themeTopics.map((n, i) => [n.id, i]))
  const mementos = others.filter((n) => n.kind === 'memento_relic')
  const cloud = others.filter((n) => n.kind !== 'memento_relic')

  // Stable per-id randomness: a star's place must not jump when its neighbours change.
  // The old (h*31 + c) % 1000 hash mapped `fact:1 … fact:60` to nearly the same value
  // (measured: every angle inside a 3% band), which piled each cluster into one arc.
  // FNV-1a plus an avalanche finaliser spreads sequential ids uniformly.
  const hashNum = (s) => {
    let h = 2166136261
    const t = String(s || '')
    for (let i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  const h01 = (id, salt = 0) => {
    let x = (hashNum(id) ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0
    x ^= x >>> 16
    x = Math.imul(x, 0x7feb352d)
    x ^= x >>> 15
    x = Math.imul(x, 0x846ca68b)
    x ^= x >>> 16
    return (x >>> 0) / 4294967296
  }
  const TAU = Math.PI * 2
  /** Hash-based point on a flattened ring; stable per id, no dependence on array order. */
  const ringPos = (id, radius, salt, flat = 0.5) => {
    const a = h01(id, salt) * TAU
    const u = h01(id, salt + 1) * 2 - 1
    const ring = Math.sqrt(Math.max(0, 1 - u * u))
    const r = radius * (0.92 + 0.16 * h01(id, salt + 2))
    return { x: Math.cos(a) * ring * r, y: u * r * flat, z: Math.sin(a) * ring * r }
  }

  // --- gold suns: two spiral arms, so the sky has a readable shape ---
  themeTopics.forEach((node, i) => {
    const n = themeTopics.length
    const t = n > 1 ? i / (n - 1) : 0.5
    const a = t * Math.PI * 2.2 + 0.4
    // A lone theme sits at the heart of the sky; arms only make sense with several.
    const r = n <= 1 ? 0 : (5 + 6.5 * t) * (0.94 + 0.12 * h01(node.id, 1))
    world.set(node.id, {
      x: Math.cos(a) * r,
      y: (h01(node.id, 2) - 0.5) * 2.8,
      z: Math.sin(a) * r,
    })
  })

  // --- facts orbit ONLY real themes; dream pages never own children ---
  const parentOfFact = new Map()
  for (const link of links) {
    if (!link || (link.kind && link.kind !== 'topic_cluster')) continue
    const a = link.source
    const b = link.target
    if (themeIds.has(b) && !themeIds.has(a)) parentOfFact.set(a, b)
    else if (themeIds.has(a) && !themeIds.has(b)) parentOfFact.set(b, a)
  }
  // Facts the graph never linked no longer get round-robined onto an arbitrary sun —
  // that fabricated a relationship. Same-topic strays gather into their own small
  // drift constellation between the arms and the diary band.
  const driftBuckets = new Map()
  for (const f of facts) {
    if (parentOfFact.has(f.id)) continue
    const key = String(f.label || '').trim() || '零散'
    if (!driftBuckets.has(key)) driftBuckets.set(key, [])
    driftBuckets.get(key).push(f)
  }

  const perTheme = new Map()
  for (const p of parentOfFact.values()) perTheme.set(p, (perTheme.get(p) || 0) + 1)
  let maxCloudR = CLOUD_MIN
  for (const k of perTheme.values()) maxCloudR = Math.max(maxCloudR, cloudShell(k))
  let themeExtent = 5
  for (const p of world.values()) themeExtent = Math.max(themeExtent, Math.hypot(p.x, p.z))

  // --- blue dust around its sun: hash-based spherical cloud, stable per id ---
  for (const f of facts) {
    const parent = parentOfFact.get(f.id)
    if (!parent) continue
    const parentPos = world.get(parent)
    if (!parentPos) continue
    const r = cloudShell(perTheme.get(parent) || 1)
    const u = h01(f.id, 3) * 2 - 1
    const ring = Math.sqrt(Math.max(0, 1 - u * u))
    const ang = h01(f.id, 4) * TAU + (themeIds.get(parent) || 0) * 0.7
    const dist = r * (0.55 + 0.45 * h01(f.id, 5))
    world.set(f.id, {
      x: parentPos.x + Math.cos(ang) * ring * dist,
      y: parentPos.y + u * dist * 0.9,
      z: parentPos.z + Math.sin(ang) * ring * dist,
    })
  }

  // --- drift constellations: unlinked facts grouped by their own topic ---
  const driftR = themeExtent + maxCloudR + 3.2
  const grouped = [...driftBuckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const solidBuckets = grouped.filter(([, g]) => g.length >= 2)
  const singletons = grouped.filter(([, g]) => g.length === 1).map(([, g]) => g[0])
  solidBuckets.forEach(([label, group], bi) => {
    const a0 = bi * 2.399963 + 0.7
    const jitter = (h01(label, 6) - 0.5) * 1.2
    const centre = {
      x: Math.cos(a0) * (driftR + jitter),
      y: (h01(label, 7) - 0.5) * 5,
      z: Math.sin(a0) * (driftR + jitter),
    }
    const rr = 1.4 + Math.min(2.4, 0.55 * Math.sqrt(group.length))
    group.forEach((f) => {
      const u = h01(f.id, 8) * 2 - 1
      const ring = Math.sqrt(Math.max(0, 1 - u * u))
      const ang = h01(f.id, 9) * TAU
      const dist = rr * (0.4 + 0.6 * h01(f.id, 10))
      world.set(f.id, {
        x: centre.x + Math.cos(ang) * ring * dist,
        y: centre.y + u * dist,
        z: centre.z + Math.sin(ang) * ring * dist,
      })
    })
  })
  // Lone strays share one loose "wandering dust" band instead of fanning out into
  // dozens of unrelated one-star constellations — that read as noise, not structure.
  if (singletons.length) {
    const rr = 2.2 + Math.min(3.2, 0.4 * Math.sqrt(singletons.length))
    singletons.forEach((f) => {
      const u = h01(f.id, 16) * 2 - 1
      const ring = Math.sqrt(Math.max(0, 1 - u * u))
      const ang = h01(f.id, 17) * TAU
      const r = driftR + 1.6 + rr * h01(f.id, 18)
      world.set(f.id, {
        x: Math.cos(ang) * ring * r,
        y: u * r * 0.5,
        z: Math.sin(ang) * ring * r,
      })
    })
  }

  // --- outer bands derived from the ACTUAL theme extent, not the old shell formula ---
  // Ordered rings: diary chains follow date order, so consecutive entries must sit next
  // to each other on the ring — hash scatter turned every chain link into a long arc.
  const epShell = themeExtent + maxCloudR + 5.5
  const placeOrdered = (list, radius, flat, phase, salt) => {
    const sorted = list.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
    sorted.forEach((node, i) => {
      const a = (i / Math.max(1, sorted.length)) * TAU + phase
      const r = radius * (0.96 + 0.08 * h01(node.id, salt))
      world.set(node.id, {
        x: Math.cos(a) * r,
        y: (h01(node.id, salt + 1) - 0.5) * r * flat * 0.9,
        z: Math.sin(a) * r,
      })
    })
  }
  placeOrdered(dreamTopics, epShell + 1.2, 0.85, 0.3, 11)
  placeOrdered(episodes, epShell, 0.85, 1.1, 12)
  placeOrdered(sessionStars, epShell + 2.2, 0.85, 2.0, 13)
  placeOrdered(transcripts, epShell + 3.8, 0.85, 2.6, 16)
  // Mementos are souvenirs, not cloud copies: an inner relic belt, never the far rim.
  mementos.forEach((node) => {
    const p = ringPos(node.id, epShell - 2.4, 14, 0.5)
    world.set(node.id, p)
  })
  // Remote cloud replicas live on a thin far halo (warp beams stay long but faint).
  cloud.forEach((node) => {
    const p = ringPos(node.id, epShell + 10, 15, 0.6)
    world.set(node.id, p)
  })

  // --- shielded memories: parked far out on their own arc, never inside the sky ---
  shielded.forEach((node, i) => {
    const a = i * 2.399963
    world.set(node.id, {
      x: -PRIVATE_DISTANCE - (i % 3) * 1.6,
      y: Math.sin(a) * 7.5,
      z: Math.cos(a) * 7.5,
    })
  })

  // Center the sky on the origin: the spiral's centroid is not (0,0,0), which left the
// galaxy hugging one side of the canvas at higher tilts. A uniform shift keeps every
// relative distance and stays deterministic.
  let cx = 0, cy = 0, cz = 0
  for (const p of world.values()) { cx += p.x; cy += p.y; cz += p.z }
  const count = Math.max(1, world.size)
  cx /= count; cy /= count; cz /= count
  for (const [id, p] of world) world.set(id, { x: p.x - cx, y: p.y - cy, z: p.z - cz })

  // Depth normalisation for the renderer: half the sky's extent, so `near` actually
  // spans 0..1 instead of hugging the middle of the ramp.
  let extent = 1
  for (const p of world.values()) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
    if (d > extent) extent = d
  }

  // Framing radius = theme suns × pad for their dust clouds. Drift bands / diary /
  // private corners must not enter — they inflate the fit and squash the living arms
  // into a central blot with empty margins (the card-view failure mode).
  let themeR = 1
  for (const n of themeTopics) {
    const p = world.get(n.id)
    if (!p) continue
    const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
    if (d > themeR) themeR = d
  }
  const coreExtent = Math.max(themeR * 1.55, themeR + maxCloudR * 0.85, 6)

  const out = { world, halfDepth: extent / 3, extent, coreExtent }
  layouts.set(graph, out)
  return out
}

module.exports = { layoutMemoryGalaxy, topicShell, cloudShell }