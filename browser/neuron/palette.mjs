// Memory star-sea palette — one cool night ink, one warm vault accent.
// Mystery comes from darkness and negative space, never from neon.
const SKY_TOP = '#030509'
const SKY_BOTTOM = '#0a1122'
const BAND_CORE = 'rgba(96,120,200,0.055)'
const BAND_EDGE = 'rgba(140,170,255,0.028)'
const NEBULA_A = 'rgba(64,86,180,0.050)'
const NEBULA_B = 'rgba(118,92,200,0.035)'
const VIGNETTE = 'rgba(2,4,10,0.55)'

/** Star tint per memory kind: cool blues, gold vault, dim violet for shielded. */
const NODE_TINT = {
  fact_neuron: [158, 196, 255],
  wiki_star: [255, 213, 148],
  episode_crystal: [186, 228, 255],
  session_star: [255, 179, 71], // warm orange #ffb347 — chat-session episodes
  private_shielded: [146, 128, 214],
}
const NODE_FALLBACK = [172, 202, 255]
function nodeTint(kind) {
  return NODE_TINT[kind] || NODE_FALLBACK
}

/** The DeepSeek whale: star-filled indigo body, pearl belly, cyan rim light. */
const WHALE = {
  bodyTop: '#2f7bff',
  bodyMid: '#1246c8',
  bodyDeep: '#0a2a86',
  rim: 'rgba(158,224,255,0.85)',
  glow: 'rgba(86,178,255,0.50)',
  belly: '#eef5ff',
  bellyShade: 'rgba(148,178,225,0.55)',
  starWhite: '255,255,255',
  starGold: '255,224,166',
  wake: '150,205,255',
}

module.exports = {
  SKY_TOP, SKY_BOTTOM, BAND_CORE, BAND_EDGE, NEBULA_A, NEBULA_B, VIGNETTE,
  NODE_TINT, NODE_FALLBACK, nodeTint, WHALE,
}
