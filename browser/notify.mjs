// Built-in desktop toasts (bottom-right system notifications via Notification API).
// Polls the node-half activity feed and mirrors the meaningful moments into OS
// Notification cards: she spoke first, finished a video, wrote the diary, dreamed,
// or a promise came due. Permission is requested once on the first user gesture;
// the whole surface is opt-out via config.notify.enabled.
//
// Chat replies: toast shows a clipped preview; click opens the session and a
// dialog with the full专属窗 / conversation text.
const { api } = require('./util.mjs')
const { tryOpenSessionClient } = require('./panel-mbti.mjs')
const { requestSoulmateTab } = require('./panel-nav.mjs')

const POLL_MS = 1500
const ICON_NOTIFY = '/dsh-soulmate/api/notify-icon'
const ICON_SPRITE = '/dsh-soulmate/api/sprite'
/** Windows toast body budget — long replies are clipped; full text opens on click. */
const TOAST_BODY = 120

function stripPlanning(text) {
  let t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim()
  if (!t) return ''
  const isPlanLine = (line) => {
    const s = String(line || '').trim()
    if (!s) return false
    if (/不需要工具|简短回应|用户就是|晚间闲聊时段|系统[:：]/.test(s)) return true
    if (/人设/.test(s) && s.length <= 40) return true
    if (/^保持.{0,20}(人设|话少)/.test(s)) return true
    if (/^(思考|网页搜索|上下文注入|搜索网页)\b/.test(s)) return true
    if (/^思考\s*[·•]/.test(s) || /^网页搜索\s*[·•]/.test(s)) return true
    if (/User wants more|Compose a digest|Search for more/i.test(s)) return true
    return false
  }
  const lines = t.split('\n')
  let i = 0
  while (i < lines.length && (isPlanLine(lines[i]) || !String(lines[i] || '').trim())) i += 1
  if (i > 0 && i < lines.length) t = lines.slice(i).join('\n').trim()
  t = t.replace(/^保持[^。\n]{0,30}人设[^。\n]{0,12}[。．]\s*/u, '').trim()
  t = t.replace(/^[^。\n]{0,24}人设[，,][^。\n]{0,12}[。．]\s*/u, '').trim()
  const parts = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (parts.length > 1 && isPlanLine(parts[0])) t = parts.slice(1).join('\n\n').trim()
  return t
}

function isCompanionLine(text) {
  const spoken = stripPlanning(text)
  const t = spoken.replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (/Same wake|GUI URL|Keep it very short|new port \d+|respond briefly|in character/i.test(t)) return false
  if (/Keep it to one|Actually counting|let me count|turn\d+\s*wake|msg\d+\b/i.test(t)) return false
  if (/^(Note the |Keep it |Respond briefly|Again\.)/i.test(t)) return false
  if (/不需要工具调用|简短回应，别长篇|用户就是闲聊/.test(t)) return false
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (t.match(/[A-Za-z]/g) || []).length
  if (latin >= 12 && latin > cjk && /wake|port \d+|Keep it|GUI URL|in character/i.test(t)) return false
  if (latin >= 12 && latin > cjk && cjk < 2) return false
  // All DSH chats: Chinese preferred; other languages need real length.
  if (cjk >= 2) return true
  return t.length >= 40
}

function clipText(s, len) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > len ? t.slice(0, len - 1) + '…' : t
}

function toastFor(ev, name) {
  const n = String(name || 'soulmate').trim() || 'soulmate'
  switch (ev.type) {
    case 'proactive': {
      if (!isCompanionLine(ev.text)) return null
      const full = stripPlanning(ev.text) || String(ev.text || '').trim()
      return {
        title: n,
        body: clipText(full, TOAST_BODY) || '来看看～',
        fullText: full,
        sessionId: String(ev.sessionId || ''),
        tag: 'dsh-soulmate-proactive',
      }
    }
    case 'pet-say': {
      if (ev.preview === true) return null
      const kind = String(ev.kind || '')
      if (kind === 'proactive') return null
      if (!isCompanionLine(ev.text)) return null
      const full = stripPlanning(ev.text) || String(ev.text || '').trim()
      const line = clipText(full, TOAST_BODY)
      if (!line) return null
      return {
        title: n,
        body: line,
        fullText: full,
        sessionId: String(ev.sessionId || ''),
        tag: 'dsh-soulmate-petsay-' + (kind || 'x'),
      }
    }
    case 'boot-greeting':
      if (ev.via === 'silent') return null
      if (ev.via === 'host') return null
      return {
        title: n,
        body: '上线了，在专属窗等你。',
        fullText: '上线了，在专属窗等你。',
        sessionId: String(ev.sessionId || ''),
        tag: 'dsh-soulmate-boot',
      }
    case 'video-watch':
      return {
        title: n + ' 看完了一个视频',
        body: clipText(ev.title, 60) + ' · 评分 ' + (ev.worthScore ?? '?') + '/20',
        fullText: String(ev.title || ''),
        tag: 'dsh-soulmate-video-watch',
      }
    case 'video-surf': {
      const first = Array.isArray(ev.videos) && ev.videos[0]
      const body = '新看了 ' + (ev.pickedCount ?? 0) + ' 个视频' + (first ? '：' + clipText(first.title, 48) : '')
      return { title: n + ' 冲浪回来', body, fullText: body, tag: 'dsh-soulmate-video-surf' }
    }
    case 'daily-diary':
      return {
        title: n + ' 写好了今天的信',
        body: ev.quiet ? '今天安静，也记了一笔。' : '去日记页看看～',
        fullText: ev.quiet ? '今天安静，也记了一笔。' : '去日记页看看～',
        tag: 'dsh-soulmate-diary',
      }
    case 'dream':
      return {
        title: n + ' 做了个梦',
        body: '把 ' + (ev.count ?? 0) + ' 条零散记忆整理成了一页 Wiki。',
        fullText: '把 ' + (ev.count ?? 0) + ' 条零散记忆整理成了一页 Wiki。',
        tag: 'dsh-soulmate-dream',
      }
    case 'promise-patrol':
      return ev.ask
        ? {
          title: n + ' 来问约定的事',
          body: '有件说好的事过期了，去专属窗看看。',
          fullText: '有件说好的事过期了，去专属窗看看。',
          tag: 'dsh-soulmate-promise',
        }
        : {
          title: n + ' 提醒约定',
          body: '今天有件事到期，去专属窗看看。',
          fullText: '今天有件事到期，去专属窗看看。',
          tag: 'dsh-soulmate-promise',
        }
    case 'persona-quiz':
      return {
        title: n + ' 的人格测验开场了',
        body: '去专属窗答第一题。',
        fullText: '去专属窗答第一题。',
        tag: 'dsh-soulmate-quiz',
      }
    case 'llm-rerouted': {
      const from = String(ev.from || '')
      const to = String(ev.to || '')
      const why = String(ev.reason || '').slice(0, 80)
      const body = '你选的 ' + from + ' 调用失败（' + why + '），这次临时改用 ' + to + '。要恢复请在 DSH 里换模型或修复该线路。'
      return {
        title: n + ' · 模型线路已临时切换',
        body,
        fullText: body,
        tag: 'dsh-soulmate-llm-reroute',
      }
    }
    case 'usage-blocked': {
      const used = Number(ev.used) || 0
      const cap = Number(ev.cap) || 0
      const detail = cap > 0 ? ('已用 ' + used + ' / ' + cap + ' tokens。') : ''
      return {
        title: n + ' · 今日自动额度用完',
        body: detail + '主动搭话已暂停；点「查看」可改每日自动额度。',
        fullText: detail + '主动搭话已暂停；点「查看」可改每日自动额度。',
        tag: 'dsh-soulmate-usage-cap',
        openTab: 'usage',
        showCapDialog: true,
        used,
        cap,
      }
    }
    default:
      return null
  }
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

function capDialogSeenKey() {
  return 'soulmate.capDialog.' + localDateKey()
}

function hasShownCapDialogToday() {
  try { return sessionStorage.getItem(capDialogSeenKey()) === '1' } catch (_) { return false }
}

function markCapDialogShown() {
  try { sessionStorage.setItem(capDialogSeenKey(), '1') } catch (_) { /* ignore */ }
}

/** In-app dialog: quota exhausted → 「查看」opens 用量统计. */
function showCapDialog(toast, companionName) {
  if (typeof document === 'undefined' || !document.body) return
  if (hasShownCapDialogToday()) return
  if (document.querySelector('.sm-cap-mask')) return
  markCapDialogShown()

  const mask = document.createElement('div')
  mask.className = 'sm-cap-mask'
  mask.setAttribute('role', 'dialog')
  mask.setAttribute('aria-modal', 'true')

  const box = document.createElement('div')
  box.className = 'sm-cap-dialog'
  const title = document.createElement('h3')
  title.textContent = (companionName || '伙伴') + ' · 今日自动额度用完'
  const body = document.createElement('p')
  const used = Number(toast && toast.used) || 0
  const cap = Number(toast && toast.cap) || 0
  body.textContent = (cap > 0 ? ('已用 ' + used + ' / ' + cap + ' tokens。') : '')
    + '主动搭话等自动调用已暂停到明天；你自己聊天不受影响。可到「用量统计」调整每日自动额度。'

  const actions = document.createElement('div')
  actions.className = 'sm-cap-actions'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'sm-btn'
  dismiss.textContent = '知道了'
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'sm-btn primary'
  view.textContent = '查看'

  const close = () => {
    try { mask.remove() } catch (_) { /* ignore */ }
  }
  dismiss.onclick = close
  mask.addEventListener('click', (ev) => { if (ev.target === mask) close() })
  view.onclick = () => {
    close()
    focusHarnessWindow()
    requestSoulmateTab('usage', { sidebarLabel: companionName })
  }

  actions.appendChild(dismiss)
  actions.appendChild(view)
  box.appendChild(title)
  box.appendChild(body)
  box.appendChild(actions)
  mask.appendChild(box)
  document.body.appendChild(mask)
}

function absUrl(path) {
  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
    if (origin && /^https?:/i.test(origin)) return origin + path
  } catch (_) { /* ignore */ }
  return path
}

/**
 * Keep Notification instances alive. Chromium/Electron GC the object (and its
 * onclick) when nothing retains it — click then only OS-focuses the app and
 * never opens the matching conversation.
 */
const liveNotes = new Set()
let pendingOpenSessionId = ''
let pendingOpenTimer = 0
/** Last toast that could be opened if OS focuses the app without firing Notification.onclick. */
let lastToastForRestore = null
let docWasHidden = typeof document !== 'undefined' ? !!document.hidden : false

function retainNotification(note) {
  if (!note) return
  liveNotes.add(note)
  const drop = () => {
    liveNotes.delete(note)
    try { note.removeEventListener('close', drop) } catch (_) { /* ignore */ }
  }
  try { note.addEventListener('close', drop) } catch (_) { /* ignore */ }
}

/**
 * Bring Harness to the foreground. Renderer cannot open dsh:// (Electron denies non-http
 * window.open); ask the node half to spawn the OS protocol handler instead.
 */
function focusHarnessWindow(sessionId) {
  try { window.focus() } catch (_) { /* ignore */ }
  const sid = String(sessionId || '').trim()
  api('notify/focus', sid ? { sessionId: sid } : {}).catch(() => {})
}

function tryOpenSoon(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return
  pendingOpenSessionId = id
  const attempt = () => {
    if (!pendingOpenSessionId) return
    try {
      if (tryOpenSessionClient(pendingOpenSessionId)) pendingOpenSessionId = ''
    } catch (_) { /* retry */ }
  }
  attempt()
  if (!pendingOpenSessionId) return
  clearTimeout(pendingOpenTimer)
  let n = 0
  const tick = () => {
    if (!pendingOpenSessionId || n >= 12) {
      pendingOpenSessionId = ''
      return
    }
    n += 1
    attempt()
    if (pendingOpenSessionId) pendingOpenTimer = setTimeout(tick, 250)
  }
  pendingOpenTimer = setTimeout(tick, 200)
}

/** Click toast → focus Harness; open conversation or settings tab. */
function openToastTarget(toast) {
  const sid = String(toast && toast.sessionId || '').trim()
  focusHarnessWindow(sid)
  const tab = String(toast && toast.openTab || '').trim()
  if (tab) {
    requestSoulmateTab(tab, { sidebarLabel: toast && toast.sidebarLabel })
    return
  }
  if (sid) tryOpenSoon(sid)
}

function installNotifications() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  if (typeof window.Notification !== 'function') return () => {}

  let destroyed = false
  let enabled = true
  let name = 'soulmate'
  let cursor = 0
  let timer = 0
  let asked = false
  const pending = []
  let lastShownBody = ''
  let lastShownAt = 0

  const onVis = () => {
    const visible = document.visibilityState === 'visible'
    const roseFromHidden = docWasHidden && visible
    docWasHidden = !!document.hidden
    if (!visible) return
    if (pendingOpenSessionId) {
      tryOpenSoon(pendingOpenSessionId)
      return
    }
    // Windows often focuses Electron from a toast without delivering Notification.onclick.
    // If we just showed a toast while the window was in the background, open that target once.
    if (roseFromHidden && lastToastForRestore && Date.now() - lastToastForRestore.at < 45_000) {
      const t = lastToastForRestore.toast
      lastToastForRestore = null
      openToastTarget(t)
    }
  }
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('focus', onVis)

  const askOnce = () => {
    if (asked || destroyed) return
    asked = true
    try {
      if (window.Notification.permission === 'default') {
        window.Notification.requestPermission().then((p) => {
          if (p === 'granted') flushPending()
        }).catch(() => {})
      } else if (window.Notification.permission === 'granted') {
        flushPending()
      }
    } catch (_) { /* ignore */ }
  }
  const gesture = () => {
    if (window.Notification.permission === 'default' && pending.length) {
      asked = false
      askOnce()
    }
    if (window.Notification.permission === 'granted') flushPending()
  }
  window.addEventListener('pointerdown', gesture)
  window.addEventListener('keydown', gesture)
  askOnce()

  const showNow = (toast) => {
    const body = String(toast.body || '')
    if (body && body === lastShownBody && Date.now() - lastShownAt < 12_000) return true
    const v = Date.now()
    const icons = [
      absUrl(ICON_NOTIFY + '?v=' + v),
      absUrl(ICON_SPRITE + '?v=' + v),
      undefined,
    ]
    const sid = String(toast.sessionId || '').trim()
    const tagBase = toast.tag || ('dsh-soulmate-' + Math.random().toString(36).slice(2, 8))
    // Unique tag per session so Windows does not coalesce unrelated chats.
    const tag = sid ? tagBase + '-' + sid.slice(-8) : tagBase
    for (const icon of icons) {
      try {
        const opts = {
          body: toast.body,
          tag,
        }
        if (icon) opts.icon = icon
        const note = new window.Notification(toast.title, opts)
        retainNotification(note)
        lastToastForRestore = { toast, at: Date.now() }
        const onClick = () => {
          // 同一 toast 的 onclick + click 双通道 / 双击只处理一次，避免重复 focus 重试。
          if (note.__smClicked) return
          note.__smClicked = true
          lastToastForRestore = null
          openToastTarget(toast)
          try { note.close() } catch (_) { /* ignore */ }
        }
        note.onclick = onClick
        try { note.addEventListener('click', onClick) } catch (_) { /* ignore */ }
        lastShownBody = body
        lastShownAt = Date.now()
        return true
      } catch (_) { /* try next */ }
    }
    return false
  }

  const flushPending = () => {
    if (window.Notification.permission !== 'granted' || !enabled) return
    while (pending.length) {
      const t = pending.shift()
      showNow(t)
    }
  }

  const show = (toast) => {
    try {
      // Quota dialog is product-critical — show even when OS toasts are opted out.
      if (toast && toast.showCapDialog) showCapDialog(toast, name)
      if (!enabled) return
      if (window.Notification.permission !== 'granted') {
        pending.push(toast)
        if (pending.length > 8) pending.shift()
        askOnce()
        return
      }
      showNow(toast)
    } catch (_) { /* ignore */ }
  }

  async function tick() {
    if (destroyed) return
    const data = await api('events?since=' + cursor)
    if (destroyed) return
    if (data && data.ok !== false) {
      const seq = Number(data.eventSeq) || 0
      const list = Array.isArray(data.events) ? data.events : []
      if (cursor > 0 && enabled) {
        for (const ev of list) {
          const toast = toastFor(ev, name)
          if (toast) {
            if (toast.openTab) toast.sidebarLabel = name
            show(toast)
          }
        }
      }
      if (seq > cursor) cursor = seq
      const conf = data.config
      if (conf && conf.notify) enabled = conf.notify.enabled !== false
      if (data.displayName) name = String(data.displayName)
    }
    timer = setTimeout(tick, POLL_MS)
  }

  api('state').then(async (data) => {
    if (destroyed || !data || data.ok === false) return
    if (data.config && data.config.notify) enabled = data.config.notify.enabled !== false
    if (data.displayName) name = String(data.displayName)
    const seq = typeof data.eventSeq === 'number' ? data.eventSeq : 0
    if (seq > 0) {
      try {
        const since = Math.max(0, seq - 8)
        const evData = await api('events?since=' + since)
        const list = (evData && Array.isArray(evData.events)) ? evData.events : []
        const now = Date.now()
        for (const ev of list) {
          if (ev.type !== 'boot-greeting' && ev.type !== 'proactive' && ev.type !== 'pet-say') continue
          const at = Date.parse(ev.at || '')
          if (!Number.isFinite(at) || now - at > 90_000) continue
          const toast = toastFor(ev, name)
          if (toast) show(toast)
        }
      } catch (_) { /* ignore */ }
    }
    cursor = seq
    timer = setTimeout(tick, POLL_MS)
  }).catch(() => { timer = setTimeout(tick, POLL_MS) })

  return () => {
    destroyed = true
    clearTimeout(timer)
    clearTimeout(pendingOpenTimer)
    pendingOpenSessionId = ''
    lastToastForRestore = null
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('focus', onVis)
    window.removeEventListener('pointerdown', gesture)
    window.removeEventListener('keydown', gesture)
    for (const note of liveNotes) {
      try { note.close() } catch (_) { /* ignore */ }
    }
    liveNotes.clear()
  }
}

module.exports = {
  installNotifications,
  toastFor,
  TOAST_BODY,
  openToastTarget,
  retainNotification,
  liveNotes,
}
