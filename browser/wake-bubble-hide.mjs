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
  const el = textNode && textNode.parentElement
  if (!el) return null
  // Hide ONLY the smallest element that contains the marker text — never climb.
  // The old heuristic climbed ancestors until a +24-char jump and, on a sparse
  // session (one wake bubble + short composer), reached <main> and display:none'd
  // the whole chat area: the white screen. The direct parent of the marker text
  // node is the message's own text container; hiding it is enough and safe.
  const full = String(el.textContent || '').trim()
  if (full.length > 400) return null
  if (full.indexOf(WAKE_BUBBLE_MARK) < 0 && !isVisionDumpText(full)) return null
  const STRUCTURAL = /^(MAIN|SECTION|ARTICLE|NAV|ASIDE|HEADER|FOOTER|FORM|BODY)$/i
  if (STRUCTURAL.test(String(el.tagName || ''))) return null
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
