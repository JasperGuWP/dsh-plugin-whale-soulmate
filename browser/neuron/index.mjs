// Public surface of the memory star-sea renderer.
const { drawNeurons } = require('./render.mjs')
const {
  DEFAULT_VIEW, MIN_ZOOM, MAX_ZOOM, FLY_ZOOM, neuronViews, neuronViewOf,
  resetView, pickNode, flyTo, stepFly, makeProjector, fitOverviewZoom,
} = require('./camera.mjs')
const { layoutMemoryGalaxy } = require('./constellation.mjs')
const { noteEvents, progressActive } = require('./process.mjs')

/** Match the backing store to the card width (× dpr) so thin synapses stay sharp. */
function fitNeuronCanvas(canvas) {
  if (!canvas) return
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const wpx = Math.max(320, Math.round((canvas.clientWidth || 720) * dpr))
  const hpx = Math.round(wpx / 2)
  if (canvas.width !== wpx || canvas.height !== hpx) { canvas.width = wpx; canvas.height = hpx }
}

module.exports = {
  drawNeurons, DEFAULT_VIEW, MIN_ZOOM, MAX_ZOOM, FLY_ZOOM, neuronViews, neuronViewOf,
  resetView, pickNode, flyTo, stepFly, makeProjector, fitOverviewZoom,
  layoutMemoryGalaxy, noteEvents, progressActive, fitNeuronCanvas,
}