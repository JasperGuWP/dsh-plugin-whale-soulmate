// Host i18n paints the running-status line as「深度求索中」/「深度求索中，用时 …」
// (chat.deepDiving / chat.deepDivingFor, baked into the host bundle with no user
// override layer). The companion owns that voice: swap the brand string for
//「<name>思考中」in place, keeping the duration suffix the host renders.
// Pure text-node rewrite — no host internals, reversible via the disposer.
const { api } = require('./util.mjs')

const LEGACY = '深度求索'
let companionName = 'soulmate'

function labelFor(name) {
  const n = String(name || '').trim() || 'soulmate'
  return n + '思考中'
}

/** Idempotent rewrite — safe under MutationObserver + host 1s timer ticks. */
function rewriteTextNode(node) {
  const raw = String(node && node.nodeValue != null ? node.nodeValue : '')
  if (!raw) return
  const voice = labelFor(companionName)
  // Already companion voice and no host brand left — do nothing (avoids ghosting).
  if (raw.indexOf(LEGACY) < 0) return
  let next = raw.split(LEGACY + '中').join(voice)
  // Leftover brand without 中 (e.g. mid-edit ticks).
  if (next.indexOf(LEGACY) >= 0) {
    next = next.split(LEGACY).join(companionName + '思考')
  }
  // Collapse accidental doubles from racing observers / mid-string edits.
  next = next.replace(/思考思考/g, '思考')
  while (next.indexOf(voice + voice) >= 0) next = next.split(voice + voice).join(voice)
  if (next !== raw) node.nodeValue = next
}

function scan(root) {
  if (!root || typeof document === 'undefined') return
  if (root.nodeType === 3) { rewriteTextNode(root); return }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return
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
      if (rec.type === 'characterData' && rec.target && rec.target.nodeType === 3) {
        rewriteTextNode(rec.target)
        continue
      }
      for (const added of rec.addedNodes || []) scheduleScan(added)
    }
  })
  mo.observe(document.body, { subtree: true, childList: true, characterData: true })

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

module.exports = { installThinkingLabel, labelFor, LEGACY, rewriteTextNode }
