// Mirror of packages/soulmate-core/surf-schedule.mjs (browser bundle cannot import packages/).

const SURF_INTERVAL_MINUTES = Object.freeze([
  10, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1440,
])

function nearestPreset(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes) || 0))
  let best = SURF_INTERVAL_MINUTES[0]
  let bestDiff = Math.abs(best - m)
  for (const p of SURF_INTERVAL_MINUTES) {
    const d = Math.abs(p - m)
    if (d < bestDiff) {
      best = p
      bestDiff = d
    }
  }
  return best
}

function resolveSurfIntervalMinutes(ext) {
  const rawMin = Number(ext && ext.biliAutoSurfEveryMinutes)
  if (Number.isFinite(rawMin) && rawMin > 0) return nearestPreset(rawMin)
  const rawHours = Number(ext && ext.biliAutoSurfEveryHours)
  if (Number.isFinite(rawHours) && rawHours > 0) return nearestPreset(rawHours * 60)
  return 360
}

function maxPickCapForInterval(minutes) {
  const m = nearestPreset(minutes)
  if (m <= 10) return 2
  if (m <= 30) return 6
  if (m <= 60) return 10
  if (m <= 90) return 12
  if (m <= 120) return 14
  if (m <= 180) return 16
  if (m <= 240) return 18
  return 20
}

function clampSurfMaxPick(pick, minutes) {
  const cap = maxPickCapForInterval(minutes)
  const n = Math.floor(Number(pick))
  if (!Number.isFinite(n) || n < 1) return Math.min(2, cap)
  return Math.min(cap, Math.max(1, n))
}

function formatSurfIntervalLabel(minutes) {
  const m = nearestPreset(minutes)
  if (m < 60) return m + ' 分钟'
  const h = m / 60
  return Number.isInteger(h) ? (h + ' 小时') : (h + ' 小时')
}

function surfIntervalIndex(minutes) {
  const m = nearestPreset(minutes)
  const i = SURF_INTERVAL_MINUTES.indexOf(m)
  return i >= 0 ? i : SURF_INTERVAL_MINUTES.indexOf(360)
}

module.exports = {
  SURF_INTERVAL_MINUTES,
  resolveSurfIntervalMinutes,
  maxPickCapForInterval,
  clampSurfMaxPick,
  formatSurfIntervalLabel,
  surfIntervalIndex,
}
