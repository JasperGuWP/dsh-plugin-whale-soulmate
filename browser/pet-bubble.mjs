// Desktop-pet speech bubble: at most two lines of 25 characters, with an animated
// three-dot tail when the reply is longer. Own module so widget.mjs stays layout/motion
// only; the bubble owns its truncation, flip-above/below placement and hit rect.

const DEFAULT_LINE_CHARS = 25
const DEFAULT_LINES = 2
const DEFAULT_TTL_MS = 10_000
const EDGE_FLIP_PX = 6

function normalizeText(text) {
  return String(text == null ? '' : text)
    // The companion reply can carry light Markdown; a 2-line preview should not show **.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split a reply into at most `lines` lines of `lineChars` characters.
 * Surrogate pairs count as one character (Array.from), so emoji never split mid-glyph.
 * @returns {{ lines: string[], truncated: boolean, fullLength: number }}
 */
function splitPetBubbleText(text, { lineChars = DEFAULT_LINE_CHARS, lines = DEFAULT_LINES } = {}) {
  const perLine = Math.max(1, Math.floor(Number(lineChars) || DEFAULT_LINE_CHARS))
  const maxLines = Math.max(1, Math.floor(Number(lines) || DEFAULT_LINES))
  const chars = Array.from(normalizeText(text))
  const max = perLine * maxLines
  const truncated = chars.length > max
  const shown = truncated ? chars.slice(0, max) : chars
  const out = []
  for (let i = 0; i < shown.length; i += perLine) out.push(shown.slice(i, i + perLine).join(''))
  return { lines: out, truncated, fullLength: chars.length }
}

/**
 * Build the bubble inside `mount` (the pet card; position:relative).
 * The window form is transparent and full-screen, so the bubble may extend above the
 * card — the widget unions its rect into the body rect used for click-through.
 */
function createPetBubble({ doc, mount, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!doc || !mount || typeof doc.createElement !== 'function') return null

  const el = doc.createElement('div')
  el.className = 'sm-pet-say sm-pet-say-window'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')

  const lineEls = [doc.createElement('span'), doc.createElement('span')]
  lineEls[0].className = 'sm-pet-line'
  lineEls[1].className = 'sm-pet-line sm-pet-line-2'

  const dots = doc.createElement('span')
  dots.className = 'sm-pet-dots'
  dots.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 3; i += 1) dots.appendChild(doc.createElement('i'))

  el.appendChild(lineEls[0])
  el.appendChild(lineEls[1])
  mount.appendChild(el)

  let visible = false
  let hideTimer = 0
  let lastKey = ''

  function setBelow(next) {
    if (el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('sm-pet-say-below', !!next)
    }
  }

  function hide() {
    visible = false
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
    if (el.classList && typeof el.classList.remove === 'function') el.classList.remove('on')
  }

  function show(text, { at = '', ttl, loading = false } = {}) {
    const clean = normalizeText(text)
    if (!clean) return false
    const key = `${at}|${clean}`
    // The state poll repeats the same petSay every 2s; do not restart or resurrect it.
    if (key === lastKey) return false
    lastKey = key

    const { lines } = splitPetBubbleText(clean)
    lineEls[0].textContent = lines[0] || ''
    lineEls[1].textContent = ''
    const hasSecond = lines.length > 1
    if (hasSecond && lines[1]) lineEls[1].appendChild(doc.createTextNode(lines[1]))
    lineEls[1].style.display = hasSecond ? '' : 'none'
    // Dots are a loading indicator only. A settled reply is clipped at 2×25 with no
    // animated tail — "loading finished" must look finished.
    if (loading === true) (hasSecond ? lineEls[1] : lineEls[0]).appendChild(dots)

    setBelow(false)
    if (el.style && typeof el.style.setProperty === 'function') {
      el.style.setProperty('--sm-pet-bubble-shift', '0px')
    }
    if (el.classList && typeof el.classList.add === 'function') el.classList.add('on')
    visible = true
    // Near the top of the virtual screen the bubble would be clipped: flip below the pet.
    // Near a side edge, shift it back inside instead of letting the transparent window clip.
    try {
      let r = el.getBoundingClientRect()
      const vw = Number(doc.defaultView && doc.defaultView.innerWidth) || 0
      if (r && vw > 0) {
        let shift = 0
        if (r.right > vw - 8) shift = (vw - 8) - r.right
        else if (r.left < 8) shift = 8 - r.left
        if (shift && el.style && typeof el.style.setProperty === 'function') {
          el.style.setProperty('--sm-pet-bubble-shift', `${Math.round(shift)}px`)
          r = el.getBoundingClientRect()
        }
      }
      if (r && r.top < EDGE_FLIP_PX) setBelow(true)
    } catch { /* layout unavailable in tests */ }

    if (hideTimer) clearTimeout(hideTimer)
    // `show({ttl})` overrides; otherwise the factory TTL applies. Reading the raw
    // `ttl` here made the default undefined → no timer → the bubble stayed forever.
    const lifeMs = Number.isFinite(Number(ttl)) ? Number(ttl) : ttlMs
    hideTimer = lifeMs > 0 ? setTimeout(hide, lifeMs) : 0
    return true
  }

  function rect() {
    if (!visible) return null
    try { return el.getBoundingClientRect() } catch { return null }
  }

  function contains(x, y) {
    const r = rect()
    if (!r) return false
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  function dispose() {
    hide()
    if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el)
  }

  if (typeof el.addEventListener === 'function') {
    el.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      hide()
    })
  }

  return {
    el,
    show,
    hide,
    visible: () => visible,
    rect,
    contains,
    dispose,
    split: (text) => splitPetBubbleText(text),
  }
}

module.exports = { splitPetBubbleText, createPetBubble, DEFAULT_LINE_CHARS, DEFAULT_LINES, DEFAULT_TTL_MS }