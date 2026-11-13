// 16:9 pet stage: sprite slot + video mount + dedicated hit box.
// Stage owns layout size; hit is the only pointer-events:auto surface.
// sizePx = stage height; width = round(height * 16/9).

/** Hit box as fractions of the stage (character body, not letterbox). */
const HIT_FRAC = { left: 0.31, top: 0.14, width: 0.38, height: 0.79 }

/**
 * @param {{ spriteImg: HTMLElement, canvas?: HTMLElement }} opts
 * @returns stage API
 */
function createPetStage({ spriteImg, canvas }) {
  const stage = document.createElement('div')
  stage.className = 'sm-pet-stage'

  if (canvas) stage.appendChild(canvas)
  if (spriteImg) {
    spriteImg.classList.add('sm-pet-stage-sprite')
    stage.appendChild(spriteImg)
  }

  const hit = document.createElement('div')
  hit.className = 'sm-pet-hit'
  hit.title = '按住拖动 · 滚轮缩放 · 单击轻触 +2 · 双击互动'
  hit.setAttribute('role', 'button')
  hit.style.left = HIT_FRAC.left * 100 + '%'
  hit.style.top = HIT_FRAC.top * 100 + '%'
  hit.style.width = HIT_FRAC.width * 100 + '%'
  hit.style.height = HIT_FRAC.height * 100 + '%'
  stage.appendChild(hit)

  let heightPx = 148

  function setSize(px) {
    heightPx = Math.max(1, Math.round(Number(px) || 148))
    const w = Math.round(heightPx * 16 / 9)
    stage.style.width = w + 'px'
    stage.style.height = heightPx + 'px'
    return { width: w, height: heightPx }
  }

  function setSpriteVisible(on) {
    if (!spriteImg) return
    spriteImg.style.display = on ? '' : 'none'
  }

  setSize(heightPx)

  return {
    stage,
    hit,
    videoMount: stage,
    setSize,
    setSpriteVisible,
    width: () => Math.round(heightPx * 16 / 9),
    height: () => heightPx,
    HIT_FRAC,
  }
}

module.exports = { createPetStage, HIT_FRAC }
