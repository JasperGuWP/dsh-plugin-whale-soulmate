// Hide chat-home wake notices that sessionController.prompt paints as user bubbles.
// Marker MUST match packages/soulmate-core/chat-home.mjs WAKE_BUBBLE_MARK.
const WAKE_BUBBLE_MARK = '\u2063\u2063soulmate-wake\u2063\u2063'

/** Internal bili vision dump formerly posted into the dedicated session (must not show). */
function isVisionDumpText(text) {
  const t = String(text || '')
  if (!t) return false
  if (t.includes('你是视频内容分析助手')) return true
  if (t.includes('画面帧（按时间）') && /输出格式（严格）|以画面为准/.test(t)) return true
  return false
}

function isWakeText(text) {
  const t = String(text || '')
  return t.startsWith(WAKE_BUBBLE_MARK) || t.indexOf(WAKE_BUBBLE_MARK) === 0
}

/** Climb to the smallest ancestor that still looks like one message bubble. */
function bubbleFromTextNode(textNode) {
  let el = textNode && textNode.parentElement
  if (!el) return null
  while (el.parentElement && el.parentElement !== document.body) {
    const parent = el.parentElement
    const et = String(el.textContent || '').trim()
    const pt = String(parent.textContent || '').trim()
    // Parent carries many other messages → current el is the bubble.
    if (pt.length > et.length + 24) return el
    el = parent
  }
  return el
}

function hideBubble(bubble, attr) {
  if (!bubble || bubble.getAttribute(attr) === '1') return
  bubble.style.display = 'none'
  bubble.setAttribute(attr, '1')
  bubble.setAttribute('aria-hidden', 'true')
}

function hideIfWake(textNode) {
  const raw = String(textNode && textNode.nodeValue != null ? textNode.nodeValue : '')
  if (raw.indexOf(WAKE_BUBBLE_MARK) < 0 && !isVisionDumpText(raw)) return
  const bubble = bubbleFromTextNode(textNode)
  if (!bubble) return
  const full = String(bubble.textContent || '').trim()
  if (isVisionDumpText(full)) {
    hideBubble(bubble, 'data-sm-vision-hidden')
    return
  }
  if (bubble.getAttribute('data-sm-wake-hidden') === '1') return
  if (!full.includes(WAKE_BUBBLE_MARK)) return
  // Hide wake-only bubbles; skip long user replies that merely quote the marker.
  if (!full.startsWith(WAKE_BUBBLE_MARK) && full.length > 160) return
  hideBubble(bubble, 'data-sm-wake-hidden')
}

function scan(root) {
  if (!root || typeof document === 'undefined') return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    hideIfWake(node)
    node = walker.nextNode()
  }
}

/**
 * Install a document-wide observer. Returns a disposer.
 */
function installWakeBubbleHider() {
  if (typeof document === 'undefined' || !document.body) return () => {}
  scan(document.body)
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData' && rec.target && rec.target.nodeType === 3) {
        hideIfWake(rec.target)
        continue
      }
      for (const added of rec.addedNodes || []) {
        if (added.nodeType === 3) hideIfWake(added)
        else if (added.nodeType === 1) scan(added)
      }
    }
  })
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  return () => {
    try { mo.disconnect() } catch (_) { /* ignore */ }
  }
}

module.exports = {
  WAKE_BUBBLE_MARK,
  isWakeText,
  isVisionDumpText,
  installWakeBubbleHider,
  scanWakeBubbles: scan,
}
