// Host i18n paints the running-status line as「深度求索中」/「深度求索中，用时 …」
// (chat.deepDiving / chat.deepDivingFor, baked into the host bundle with no user
// override layer). The companion owns that voice: swap the brand string for
//「<name>思考中」in place, keeping the duration suffix the host renders.
//
// Host TextShimmer also mirrors the label into data-shimmer-text for a decorative
// ::after overlay. Rewriting only the text node leaves the attr on the host brand
// → two strings stack (ghost overlap). Keep both in sync.
// Pure text/attr rewrite — no host internals, reversible via the disposer.
const { api } = require('./util.mjs')

const LEGACY = '深度求索'
let companionName = 'soulmate'

function labelFor(name) {
  const n = String(name || '').trim() || 'soulmate'
  return n + '思考中'
}

/** Shared brand→companion transform — used for text nodes and shimmer attrs. */
function rewriteBrand(raw) {
  const text = String(raw != null ? raw : '')
  if (!text || text.indexOf(LEGACY) < 0) return text
  const voice = labelFor(companionName)
  let next = text.split(LEGACY + '中').join(voice)
  if (next.indexOf(LEGACY) >= 0) {
    next = next.split(LEGACY).join(companionName + '思考')
  }
  next = next.replace(/思考思考/g, '思考')
  while (next.indexOf(voice + voice) >= 0) next = next.split(voice + voice).join(voice)
  return next
}

/** Idempotent rewrite — safe under MutationObserver + host 1s timer ticks. */
function rewriteTextNode(node) {
  const raw = String(node && node.nodeValue != null ? node.nodeValue : '')
  if (!raw || raw.indexOf(LEGACY) < 0) return
  const next = rewriteBrand(raw)
  if (next !== raw) node.nodeValue = next
  // Host TextShimmer keeps a parallel data-shimmer-text for ::after — sync it now.
  syncShimmerNear(node)
}
/** Keep TextShimmer decorative ::after (attr(data-shimmer-text)) on companion voice. */
function rewriteShimmerAttr(el) {
  if (!el || typeof el.getAttribute !== 'function') return
  const raw = el.getAttribute('data-shimmer-text')
  if (raw == null || raw.indexOf(LEGACY) < 0) return
  const next = rewriteBrand(raw)
  if (next !== raw && typeof el.setAttribute === 'function') {
    el.setAttribute('data-shimmer-text', next)
  }
}

function syncShimmerNear(node) {
  let el = node && node.parentElement
  while (el) {
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-shimmer')) {
      const nodes = typeof el.querySelectorAll === 'function'
        ? el.querySelectorAll('[data-shimmer-text]')
        : []
      for (const target of nodes) rewriteShimmerAttr(target)
      return
    }
    el = el.parentElement
  }
}

function scan(root) {
  if (!root || typeof document === 'undefined') return
  if (root.nodeType === 3) { rewriteTextNode(root); return }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return
  if (typeof root.getAttribute === 'function' && root.getAttribute('data-shimmer-text') != null) {
    rewriteShimmerAttr(root)
  }
  if (typeof root.querySelectorAll === 'function') {
    for (const el of root.querySelectorAll('[data-shimmer-text]')) rewriteShimmerAttr(el)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    rewriteTextNode(node)
    node = walker.nextNode()
  }
}

/**
 * Install a document-wide observer that keeps the running label in the companion's
 * voice. Returns a disposer. Name refreshes from /api/state so a rename in settings
 * propagates without a reload.
 */
function installThinkingLabel() {
  if (typeof document === 'undefined' || !document.body) return () => {}
  // Guard against double-apply (HMR / duplicate plugin mount) stacking observers.
  if (document.documentElement.getAttribute('data-sm-thinking-label') === '1') {
    return () => {}
  }
  document.documentElement.setAttribute('data-sm-thinking-label', '1')

  scan(document.body)
  let raf = 0
  const scheduleScan = (root) => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      scan(root || document.body)
    })
  }
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes' && rec.target && rec.attributeName === 'data-shimmer-text') {
        rewriteShimmerAttr(rec.target)
        continue
      }
      if (rec.type === 'characterData' && rec.target && rec.target.nodeType === 3) {
        rewriteTextNode(rec.target)
        continue
      }
      for (const added of rec.addedNodes || []) scheduleScan(added)
    }
  })
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-shimmer-text'],
  })

  let alive = true
  const refreshName = () => {
    api('state').then((data) => {
      if (!alive || !data || data.ok === false) return
      const next = String(data.displayName || '').trim() || 'soulmate'
      if (next === companionName) return
      companionName = next
      // Re-scan: the host only repaints the label on its 1s clock tick.
      scan(document.body)
    }).catch(() => {})
  }
  refreshName()
  const nameTimer = setInterval(refreshName, 30000)

  return () => {
    alive = false
    clearInterval(nameTimer)
    if (raf) cancelAnimationFrame(raf)
    try { mo.disconnect() } catch (_) { /* ignore */ }
    try { document.documentElement.removeAttribute('data-sm-thinking-label') } catch (_) { /* ignore */ }
  }
}

module.exports = {
  installThinkingLabel,
  labelFor,
  LEGACY,
  rewriteTextNode,
  rewriteShimmerAttr,
  rewriteBrand,
}
