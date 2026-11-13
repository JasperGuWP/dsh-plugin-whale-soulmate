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
    default:
      return null
  }
}

function absUrl(path) {
  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
    if (origin && /^https?:/i.test(origin)) return origin + path
  } catch (_) { /* ignore */ }
  return path
}

/** Click toast → focus Harness and open that conversation (no modal). */
function openToastTarget(toast) {
  try { window.focus() } catch (_) { /* ignore */ }
  if (toast.sessionId) {
    try { tryOpenSessionClient(toast.sessionId) } catch (_) { /* ignore */ }
  }
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
    for (const icon of icons) {
      try {
        const opts = {
          body: toast.body,
          tag: toast.tag || ('dsh-soulmate-' + Math.random().toString(36).slice(2, 8)),
        }
        if (icon) opts.icon = icon
        const note = new window.Notification(toast.title, opts)
        note.onclick = () => {
          openToastTarget(toast)
          try { note.close() } catch (_) { /* ignore */ }
        }
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
          if (toast) show(toast)
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
    window.removeEventListener('pointerdown', gesture)
    window.removeEventListener('keydown', gesture)
  }
}

module.exports = { installNotifications, toastFor, TOAST_BODY }
