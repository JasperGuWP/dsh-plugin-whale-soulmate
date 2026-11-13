// The deep sky behind the memory stars: one gradient, a faint milky band,
// two nebula breaths and a sparse twinkling field. Restraint is the point.
const { SKY_TOP, SKY_BOTTOM, BAND_CORE, BAND_EDGE, NEBULA_A, NEBULA_B, VIGNETTE } = require('./palette.mjs')

const neuronSky = { w: 0, h: 0, stars: [], dust: [] }

function rebuildNeuronSky(w, h) {
  neuronSky.w = w
  neuronSky.h = h
  let seed = 90210
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  const stars = []
  const count = Math.max(60, Math.min(150, Math.round((w * h) / 9000)))
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rnd() * w,
      y: rnd() * h,
      r: 0.3 + rnd() * 0.85,
      d: 0.35 + rnd() * 0.65,
      tw: rnd() * Math.PI * 2,
      sp: 0.5 + rnd() * 1.2,
    })
  }
  const dust = []
  for (let i = 0; i < 24; i++) {
    dust.push({
      x: rnd() * w,
      y: rnd() * h,
      r: 0.5 + rnd() * 1.1,
      vx: (rnd() - 0.5) * 0.05,
      vy: (rnd() - 0.5) * 0.035,
      a: 0.04 + rnd() * 0.07,
    })
  }
  neuronSky.stars = stars
  neuronSky.dust = dust
}

/** Faint diagonal milky band + two nebula breaths; everything under 6% alpha. */
function drawDeepField(ctx, w, h) {
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.rotate(-0.42)
  ctx.scale(1, 0.30)
  let g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.72)
  g.addColorStop(0, BAND_CORE)
  g.addColorStop(0.55, BAND_EDGE)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(-w, -w, w * 2, w * 2)
  ctx.restore()
  const nebula = (nx, ny, rr, c) => {
    const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, rr)
    ng.addColorStop(0, c)
    ng.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = ng
    ctx.fillRect(nx - rr, ny - rr, rr * 2, rr * 2)
  }
  nebula(w * 0.24, h * 0.30, w * 0.34, NEBULA_A)
  nebula(w * 0.80, h * 0.68, w * 0.30, NEBULA_B)
}

/** Background stars parallax with the orbit — a cheap but convincing depth cue. */
function drawSky(ctx, w, h, t, view) {
  const g = ctx.createLinearGradient(0, 0, w * 0.35, h)
  g.addColorStop(0, SKY_TOP)
  g.addColorStop(1, SKY_BOTTOM)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  drawDeepField(ctx, w, h)
  const TT = t / 1000
  for (const s of neuronSky.stars) {
    const ox = (-view.yaw * 40 * s.d) % w
    const oy = view.pitch * 26 * s.d
    const x = ((s.x + ox) % w + w) % w
    const y = ((s.y + oy) % h + h) % h
    const a = 0.16 + 0.42 * (0.5 + 0.5 * Math.sin(TT * s.sp + s.tw))
    ctx.fillStyle = 'rgba(214,228,255,' + a.toFixed(3) + ')'
    ctx.beginPath()
    ctx.arc(x, y, s.r, 0, Math.PI * 2)
    ctx.fill()
    if (s.r > 1.02) {
      ctx.strokeStyle = 'rgba(214,228,255,' + (a * 0.35).toFixed(3) + ')'
      ctx.lineWidth = 0.6
      ctx.beginPath()
      ctx.moveTo(x - s.r * 2.6, y); ctx.lineTo(x + s.r * 2.6, y)
      ctx.moveTo(x, y - s.r * 2.6); ctx.lineTo(x, y + s.r * 2.6)
      ctx.stroke()
    }
  }
  for (const d of neuronSky.dust) {
    d.x = (d.x + d.vx + w) % w
    d.y = (d.y + d.vy + h) % h
    ctx.fillStyle = 'rgba(160,190,255,' + d.a.toFixed(3) + ')'
    ctx.beginPath()
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Darkened edges keep the eye in the middle of the sea. */
function drawVignette(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, VIGNETTE)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

module.exports = { neuronSky, rebuildNeuronSky, drawSky, drawVignette }
