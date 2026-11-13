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
const CLOUD_MIN = 1.8
const CLOUD_GAIN = 1.15
const CLOUD_MAX = 7.5
const EPISODE_SHELL = 11
const PRIVATE_DISTANCE = 34

const hash01 = (i) => (((i * 2654435761) >>> 0) % 1000) / 1000

/**
 * Even points on a sphere (Fibonacci spiral) — the reason nothing clumps.
 *
 * Two bugs lived here. The `phase` argument was added to the *angle* only, so i=0 always
 * pointed at the north pole regardless of the band. And `y` was clamped into [-1,1]
 * after tilting, which piled every overshooting point onto the two poles — that is why
 * collisions kept appearing at exactly (0, ±r, 0), drawn as one visible dot.
 *
 * Now the spiral is generated on a band whose latitude range is *inset* from the poles
 * by `tilt`, so no point ever reaches them, and consecutive points keep the golden-angle
 * separation that makes the distribution even in the first place.
 */
function fibSphere(i, n, r, phase = 0) {
  // inset shrinks towards 0 as a band gets big (a large band needs the full sphere)
  const inset = Math.min(0.82, 0.30 + Math.abs(phase) * 0.22)
  const t = n > 1 ? i / (n - 1) : 0.5
  // latitude runs from +inset to -inset instead of +1 to -1
  const y = (1 - 2 * t) * Math.max(0.18, 1 - inset)
  const ring = Math.sqrt(Math.max(0, 1 - y * y))
  const th = 2.399963 * i + phase * 1.7
  return { x: Math.cos(th) * ring * r, y: y * r, z: Math.sin(th) * ring * r }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Radius of the gold shell for `n` topics. */
function topicShell(n) {
  return clamp(TOPIC_SHELL_MIN + TOPIC_SHELL_GAIN * Math.sqrt(Math.max(1, n)), TOPIC_SHELL_MIN, TOPIC_SHELL_MAX)
}

/** Radius of the fact cloud for `k` facts hanging off one topic. */
function cloudShell(k) {
  return clamp(CLOUD_MIN + CLOUD_GAIN * Math.sqrt(Math.max(1, k)), CLOUD_MIN, CLOUD_MAX)
}

/**
 * Episodes get their own band, and it must clear the widest fact cloud — otherwise a
 * diary entry lands on top of a fact (measured: 0.12 units apart at 120 memories, i.e.
 * drawn as one dot). Derived from the actual cloud radius rather than a fixed offset.
 */
function episodeShell(topicCount, maxPerTopic) {
  return topicShell(topicCount) + cloudShell(maxPerTopic) + 5.5
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
  const shielded = nodes.filter((n) => n && n.kind === 'private_shielded')
  const others = nodes.filter((n) => n && !['wiki_star', 'fact_neuron', 'episode_crystal', 'session_star', 'private_shielded'].includes(n.kind))

  // --- gold suns: one per topic, evenly spaced over a wide shell ---
  const shell = topicShell(topics.length)
  const topicIndex = new Map()
  topics.forEach((node, i) => {
    topicIndex.set(node.id, i)
    const p = fibSphere(i, topics.length, shell, 0.37)
    // a breath of jitter so the spiral is not mechanical
    const j = 0.9 + 0.2 * hash01(i * 13 + 5)
    world.set(node.id, { x: p.x * j, y: p.y * j + (hash01(i * 31 + 7) - 0.5) * 1.2, z: p.z * j })
  })

  // --- which sun does each fact orbit? follow the real topic links first ---
  const clusterOf = new Map()
  for (const link of links) {
    if (!link || (link.kind && link.kind !== 'topic_cluster')) continue
    const a = link.source
    const b = link.target
    if (a && b) {
      if (topicIndex.has(b) && !topicIndex.has(a)) clusterOf.set(a, b)
      else if (topicIndex.has(a) && !topicIndex.has(b)) clusterOf.set(b, a)
    }
  }
  // facts the graph never linked still need a home: spread them over the suns
  facts.forEach((node, i) => {
    if (clusterOf.has(node.id)) return
    if (!topics.length) return
    clusterOf.set(node.id, topics[i % topics.length].id)
  })

  const perTopic = new Map()
  for (const id of clusterOf.values()) perTopic.set(id, (perTopic.get(id) || 0) + 1)
  let maxPerTopic = 1
  for (const k of perTopic.values()) if (k > maxPerTopic) maxPerTopic = k

  // --- blue dust: each fact rings the sun it belongs to ---
  const ordinal = new Map()
  facts.forEach((node, i) => {
    const parent = clusterOf.get(node.id)
    const parentPos = parent ? world.get(parent) : null
    if (!parentPos) {
      // no topics at all — a lone wanderer, still placed on its own spot in the sky
      const p = fibSphere(i, facts.length, topicShell(1) + 2, 0.11)
      world.set(node.id, { x: p.x, y: p.y, z: p.z })
      return
    }
    const k = perTopic.get(parent) || 1
    const n = ordinal.get(parent) || 0
    ordinal.set(parent, n + 1)
    const r = cloudShell(k)
    const dir = fibSphere(n, k, 1, 0.5)
    // Shell, not filled ball: the gold core must stay visible through its own dust. The
    // radial spread is stratified rather than hashed — `hash01(n*17+i)` returned nearly
    // the same value for consecutive n, so neighbouring facts landed at the same radius
    // and, with a golden-angle step, ended up 0.38 units apart (one visible dot).
    const strata = Math.max(1, Math.min(k, 7))
    const strataPick = (n * 3 + i) % strata
    const dist = r * (0.56 + 0.44 * ((strataPick + 0.5) / strata))
    world.set(node.id, {
      x: parentPos.x + dir.x * dist,
      y: parentPos.y + dir.y * dist * 0.82,
      z: parentPos.z + dir.z * dist,
    })
  })

  // --- episodes: their own wide band, offset in phase so they never stack on the first
  // fact of the first topic (both used to start at the same azimuth) ---
  const epShell = episodeShell(topics.length, maxPerTopic)
  episodes.forEach((node, i) => {
    const p = fibSphere(i, episodes.length, epShell, 2.9)
    world.set(node.id, {
      x: p.x,
      y: p.y * 0.72 + (hash01(i * 23 + 9) - 0.5) * 3,
      z: p.z,
    })
  })

  // --- session stars: own helix just outside the diary band (not dumped into `others`) ---
  sessionStars.forEach((node, i) => {
    const p = fibSphere(i, sessionStars.length, epShell + 1.4, 3.45)
    world.set(node.id, {
      x: p.x,
      y: p.y * 0.68 + (hash01(i * 29 + 11) - 0.5) * 2.8,
      z: p.z,
    })
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

  others.forEach((node, i) => {
    const p = fibSphere(i, others.length, shell + 5, 2.3)
    world.set(node.id, { x: p.x, y: p.y, z: p.z })
  })

  // Depth normalisation for the renderer: half the sky's extent, so `near` actually
  // spans 0..1 instead of hugging the middle of the ramp.
  let extent = 1
  for (const p of world.values()) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
    if (d > extent) extent = d
  }

  const out = { world, halfDepth: extent / 3, extent }
  layouts.set(graph, out)
  return out
}

module.exports = { layoutMemoryGalaxy, topicShell, cloudShell }