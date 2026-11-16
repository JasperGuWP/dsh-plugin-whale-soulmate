// Cross-surface navigation into the soulmate settings panel (sidebar main + tab).
const PENDING_TAB_KEY = 'soulmate.pendingTab'
const OPEN_TAB_EVENT = 'soulmate:open-tab'

function requestSoulmateTab(tab, opts = {}) {
  const id = String(tab || '').trim()
  if (!id) return
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(PENDING_TAB_KEY, id)
  } catch (_) { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: { tab: id } }))
  } catch (_) { /* ignore */ }
  if (opts.openSidebar !== false) tryOpenSoulmateSidebar(opts.sidebarLabel)
}

function consumePendingTab() {
  try {
    if (typeof sessionStorage === 'undefined') return ''
    const id = String(sessionStorage.getItem(PENDING_TAB_KEY) || '').trim()
    if (id) sessionStorage.removeItem(PENDING_TAB_KEY)
    return id
  } catch (_) {
    return ''
  }
}

function tryOpenSoulmateSidebar(sidebarLabel) {
  if (typeof document === 'undefined') return false
  if (document.querySelector('.sm-panel')) return true
  const labels = []
  const named = String(sidebarLabel || '').trim()
  if (named) labels.push(named)
  labels.push('soulmate', '小鱼')
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="panellist"]'))
  for (const el of nodes) {
    const t = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 24) continue
    if (labels.some((lab) => t === lab || t.startsWith(lab))) {
      try { el.click(); return true } catch (_) { /* try next */ }
    }
  }
  return false
}

module.exports = {
  OPEN_TAB_EVENT,
  PENDING_TAB_KEY,
  requestSoulmateTab,
  consumePendingTab,
  tryOpenSoulmateSidebar,
}
