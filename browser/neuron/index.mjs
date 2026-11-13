// Public surface of the memory star-sea renderer.
const { drawNeurons } = require('./render.mjs')
const {
  DEFAULT_VIEW, MIN_ZOOM, MAX_ZOOM, FLY_ZOOM, neuronViews, neuronViewOf,
  resetView, pickNode, flyTo, stepFly, makeProjector,
} = require('./camera.mjs')
const { layoutMemoryGalaxy } = require('./constellation.mjs')

module.exports = {
  drawNeurons, DEFAULT_VIEW, MIN_ZOOM, MAX_ZOOM, FLY_ZOOM, neuronViews, neuronViewOf,
  resetView, pickNode, flyTo, stepFly, makeProjector,
  layoutMemoryGalaxy,
}