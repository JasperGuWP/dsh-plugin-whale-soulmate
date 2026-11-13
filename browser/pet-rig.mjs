// Pet video+motion rig assembly: builds the A/B video layer and the locomotion driver
// with their cross-wired callbacks. Split out of widget.mjs so business glue (ended →
// next state, fail → PNG fallback re-plan) never flows back into the widget (PRD §14.A
// #3: widget only wires lifecycle). All state access goes through getter callbacks so
// the rig never captures a render-time snapshot of `pet`.

const { createPetVideoLayer, endedCue, isOnceState } = require('./pet-video.mjs')
const { createPetMotion } = require('./pet-motion.mjs')

/**
 * Build { layer, motion }.
 * deps (all getters / callbacks):
 *   mount, root, viewport, size, isDragging, isMinimized, reducedMotion,
 *   getPet() → pet | null, petVideoUrl(state) → url | null, petDwellMs(st),
 *   enter(name, t), applyFaces(t), now() → ms.
 */
function createPetRig(deps) {
  const getPet = deps.getPet
  const replanWalkPng = (pet, motion) => {
    // PNG fallback: re-plan from the current spot with a dwell-estimated distance.
    motion.stop()
    const st = (pet.manifest.states || {}).walk || {}
    const plan = motion.plan({ speedPxSec: Number(st.speedPxSec) || 40, dwellMs: deps.petDwellMs(st) })
    if (plan) pet.m.facing = plan.facing
  }
  let motion = null
  const layer = createPetVideoLayer({
    mount: deps.mount,
    isDragging: deps.isDragging,
    onEnded: (state) => {
      const pet = getPet()
      if (!pet || pet.m.state !== state) return
      const now = deps.now()
      if (state === 'walk' && motion) motion.commit()
      const next = endedCue(pet.manifest.states || {}, state, Math.random)
      if (next) { deps.enter(next, now); deps.applyFaces(now) }
    },
    onFail: (state) => {
      const pet = getPet()
      if (!pet) return
      pet.videoBroken[state] = true
      if (pet.videoState === state) pet.videoState = null
      if (pet.m.state === 'walk' && motion) replanWalkPng(pet, motion)
      deps.applyFaces(deps.now())
    },
  })
  motion = createPetMotion({
    root: deps.root,
    viewport: deps.viewport,
    size: deps.size,
    isDragging: deps.isDragging,
    isMinimized: deps.isMinimized,
    reducedMotion: deps.reducedMotion,
    video: () => (layer.activeState() === 'walk' ? layer.frontVideo() : null),
    // Only ONCE walk videos drive locomotion by currentTime; a loop walk video would
    // wrap currentTime and jump the position (PRD §5.6 / 审核 #4) → time progress.
    wantVideo: () => {
      const pet = getPet()
      if (!pet || !deps.petVideoUrl('walk')) return false
      return isOnceState((pet.manifest.states || {}).walk)
    },
    onFallback: () => {
      const pet = getPet()
      if (!pet || pet.m.state !== 'walk') return
      // Mark broken so the re-plan stays PNG (otherwise wantVideo re-pends forever).
      pet.videoBroken.walk = true
      pet.videoState = null
      layer.hide()
      replanWalkPng(pet, motion)
    },
  })
  return { layer, motion }
}

module.exports = { createPetRig }
