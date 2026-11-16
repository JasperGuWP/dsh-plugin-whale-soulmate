// DsBot tab — 已接通平台（当前：微信）。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

const QR_POLL_MS = 1500

const PLATFORMS = [
  { id: 'weixin', label: '微信' },
]

function statusLabel(status) {
  switch (status) {
    case 'wait':
    case 'pending':
    case 'scaned':
    case 'scanned':
      return '已扫码，请在手机上确认…'
    case 'confirmed':
      return '已确认'
    case 'expired':
      return '二维码已过期，请刷新'
    default:
      return status ? `状态：${status}` : '等待扫码…'
  }
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortPeer(id) {
  const s = String(id || '')
  if (s.length <= 18) return s
  return s.slice(0, 8) + '…' + s.slice(-6)
}

function DsBotCard() {
  const [platform, setPlatform] = React.useState('weixin')
  const [status, setStatus] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [enabled, setEnabled] = React.useState(false)
  const [sendText, setSendText] = React.useState('')
  const [qr, setQr] = React.useState(null)
  const [contacts, setContacts] = React.useState([])
  const [peer, setPeer] = React.useState('')
  const [messages, setMessages] = React.useState([])
  const [chatBusy, setChatBusy] = React.useState(false)
  const qrRef = React.useRef(null)
  const threadRef = React.useRef(null)
  qrRef.current = qr

  const refresh = React.useCallback(async () => {
    const res = await api('im/status')
    if (!res || res.ok === false) {
      setMsg((res && res.error) || '读不到 IM 状态')
      return
    }
    setStatus(res)
    const wx = (res.platforms && res.platforms.weixin) || {}
    setEnabled(!!wx.enabled)
  }, [])

  const loadChat = React.useCallback(async (nextPeer, { before } = {}) => {
    setChatBusy(true)
    try {
      const q = new URLSearchParams({ platform: 'weixin', limit: '50' })
      if (nextPeer) q.set('peer', nextPeer)
      if (before) q.set('before', before)
      const res = await api('im/chat?' + q.toString())
      if (!res || res.ok === false) {
        setMsg((res && res.error) || '读不到对话')
        return
      }
      setContacts(Array.isArray(res.contacts) ? res.contacts : [])
      if (nextPeer) {
        const rows = Array.isArray(res.messages) ? res.messages : []
        if (before) setMessages((prev) => [...rows, ...prev])
        else setMessages(rows)
      } else {
        setMessages([])
      }
    } finally {
      setChatBusy(false)
    }
  }, [])

  React.useEffect(() => {
    refresh().catch(() => {})
    loadChat('').catch(() => {})
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!threadRef.current) return
    threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [messages, peer])

  React.useEffect(() => {
    if (!qr?.qrcode || qr.pollStatus === 'confirmed' || qr.pollStatus === 'expired') return undefined
    let alive = true
    const tick = async () => {
      if (!alive || !qrRef.current?.qrcode) return
      const code = qrRef.current.qrcode
      try {
        const res = await api('im/config', { action: 'weixin_qr_poll', qrcode: code })
        if (!alive || qrRef.current?.qrcode !== code) return
        if (!res || res.ok === false) {
          setMsg((res && res.error) || '轮询失败')
          return
        }
        if (res.status === 'confirmed') {
          setQr(null)
          setMsg('微信已登录' + (res.accountId ? ` · ${res.accountId}` : ''))
          await refresh()
          return
        }
        setQr((prev) => (prev && prev.qrcode === code ? { ...prev, pollStatus: res.status } : prev))
        setMsg(statusLabel(res.status))
        if (res.status === 'expired') return
      } catch (err) {
        if (alive) setMsg(err && err.message ? err.message : String(err))
      }
    }
    const id = setInterval(tick, QR_POLL_MS)
    tick()
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [qr?.qrcode, refresh])

  async function startQr() {
    setBusy(true)
    setMsg('')
    try {
      const res = await api('im/config', { action: 'weixin_qr_start' })
      if (!res || res.ok === false) {
        setMsg((res && res.error) || '拉二维码失败')
        return
      }
      setQr({
        qrcode: res.qrcode,
        qrDataUrl: res.qrDataUrl || '',
        url: res.qrcodeImgContent || '',
        pollStatus: 'wait',
      })
      setMsg('请用手机微信扫码（官方 iLink Bot）')
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    setMsg('退出中…')
    try {
      const res = await api('im/config', { action: 'weixin_logout' })
      setQr(null)
      if (res && res.ok !== false) {
        setStatus(res)
        setEnabled(false)
        setMsg('已退出微信 Bot')
      } else {
        setMsg((res && res.error) || '退出失败')
      }
    } finally {
      setBusy(false)
    }
  }

  async function saveEnabled() {
    setBusy(true)
    setMsg('保存中…')
    try {
      const res = await api('im/config', {
        action: 'configure',
        platform: 'weixin',
        enabled,
        imEnabled: true,
      })
      if (res && res.ok !== false) {
        setStatus(res)
        setMsg(enabled ? '已开启微信分身。' : '已关闭微信分身（登录态仍保留）。')
      } else {
        setMsg((res && res.error) || '保存失败')
      }
    } finally {
      setBusy(false)
    }
  }

  async function pollOnce() {
    setBusy(true)
    setMsg('拉取中…')
    try {
      const res = await api('im/config', { action: 'weixin_poll', timeoutMs: 8000 })
      if (!res || res.ok === false) {
        setMsg((res && res.error) || '拉取失败')
        return
      }
      const n = Number(res.received) || 0
      const hCount = Number(res.handled) || 0
      setMsg(n ? `拉到 ${n} 条，处理 ${hCount} 条。` : '暂无新消息。请先用手机微信给 Bot 发一句。')
      await refresh()
      const nextPeer = peer || (res.results && res.results[0] && res.results[0].senderId) || ''
      if (nextPeer && !peer) setPeer(nextPeer)
      await loadChat(nextPeer || peer || '')
    } finally {
      setBusy(false)
    }
  }

  async function selectPeer(id) {
    setPeer(id)
    await loadChat(id)
  }

  async function testSend() {
    if (!sendText.trim()) {
      setMsg('请输入内容。')
      return
    }
    if (!peer) {
      setMsg('请先选左侧联系人（或让对方先发一条）。')
      return
    }
    setBusy(true)
    setMsg('发送中…')
    try {
      const res = await api('im/send', {
        platform: 'weixin',
        text: sendText.trim(),
        to: peer,
        toUserId: peer,
      })
      if (res && res.ok) {
        setSendText('')
        setMsg('已发送。')
        await loadChat(peer)
      } else {
        setMsg((res && res.error) || '发送失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const wx = (status && status.platforms && status.platforms.weixin) || {}
  const loggedIn = !!wx.configured

  const platformCols = PLATFORMS.length > 1
    ? h('div', {
      key: 'cols',
      className: 'sm-dsbot-platforms',
      role: 'tablist',
      'aria-label': 'DsBot 平台',
    }, PLATFORMS.map((p) => h('button', {
      key: p.id,
      type: 'button',
      role: 'tab',
      'aria-selected': platform === p.id ? 'true' : 'false',
      className: 'sm-dsbot-plat' + (platform === p.id ? ' on' : ''),
      onClick: () => setPlatform(p.id),
    }, [
      h('span', { key: 'badge', className: 'sm-dsbot-plat-badge' }, p.label),
    ])))
    : null

  const weixinColumn = h('div', { key: 'wx', className: 'sm-dsbot-column', 'data-platform': 'weixin' }, [
    h('header', { key: 'h', className: 'sm-dsbot-column-head' }, [
      h('span', { key: 'badge', className: 'sm-dsbot-plat-badge lg' }, '微信'),
      h('div', { key: 't' }, [
        h('h3', { key: 'title' }, '微信官方 · iLink'),
        h('p', { key: 's', className: 'sm-panel-muted' },
          loggedIn
            ? ('已登录' + (wx.accountId ? ` · ${wx.accountId}` : '') + (wx.enabled ? ' · 已开启' : ' · 未开启'))
            : '扫码登录；按人设回复；下方对话时间线。'),
      ]),
    ]),

    h('p', { key: 'note', className: 'sm-panel-muted sm-dsbot-note' },
      '正规通道：ilinkai.weixin.qq.com。对方先发一条后才能回。'),

    h('div', { key: 'actions', className: 'sm-row sm-dsbot-actions' }, [
      h('button', {
        key: 'qr', type: 'button', className: 'sm-btn primary', disabled: busy, onClick: startQr,
      }, qr ? '刷新二维码' : '扫码登录'),
      h('button', {
        key: 'poll', type: 'button', className: 'sm-btn', disabled: busy || !loggedIn, onClick: pollOnce,
      }, '拉取消息'),
      h('button', {
        key: 'ref', type: 'button', className: 'sm-btn', disabled: busy, onClick: () => { refresh(); loadChat(peer) },
      }, '刷新'),
      h('button', {
        key: 'out', type: 'button', className: 'sm-btn', disabled: busy || !loggedIn, onClick: logout,
      }, '退出'),
    ]),

    qr ? h('div', { key: 'qrbox', className: 'sm-dsbot-qr' }, [
      qr.qrDataUrl
        ? h('img', {
          key: 'img', src: qr.qrDataUrl, width: 200, height: 200, alt: '微信 Bot 登录二维码',
        })
        : h('p', { key: 'fallback', className: 'sm-panel-muted' }, '二维码图生成失败，请刷新重试'),
      h('p', { key: 'hint', className: 'sm-panel-muted' }, statusLabel(qr.pollStatus)),
      h('button', {
        key: 'cancel', type: 'button', className: 'sm-btn', disabled: busy,
        onClick: () => { setQr(null); setMsg('') },
      }, '取消'),
    ]) : null,

    loggedIn ? h('div', { key: 'on', className: 'sm-dsbot-enable' }, [
      h('label', { key: 'check', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: enabled, disabled: busy,
          onChange: (e) => setEnabled(e.target.checked),
        }),
        h('span', { key: 't' }, '开启微信分身（收到消息后按人设回复）'),
      ]),
      h('button', {
        key: 'save', type: 'button', className: 'sm-btn', disabled: busy, onClick: saveEnabled,
        style: { marginTop: 8 },
      }, '保存开关'),
    ]) : null,

    h('div', { key: 'chat', className: 'sm-dsbot-chat', 'data-testid': 'dsbot-chat' }, [
      h('aside', { key: 'list', className: 'sm-dsbot-peers' }, [
        h('div', { key: 'ph', className: 'sm-dsbot-peers-head' }, '会话'),
        contacts.length
          ? contacts.map((c) => h('button', {
            key: c.peerId,
            type: 'button',
            className: 'sm-dsbot-peer' + (peer === c.peerId ? ' on' : ''),
            onClick: () => selectPeer(c.peerId),
          }, [
            h('span', { key: 'n', className: 'sm-dsbot-peer-name' }, shortPeer(c.peerLabel || c.peerId)),
            h('span', { key: 't', className: 'sm-dsbot-peer-time' }, formatTime(c.lastAt)),
            h('span', { key: 'p', className: 'sm-dsbot-peer-preview' }, c.lastText || ''),
          ]))
          : h('p', { key: 'empty', className: 'sm-panel-muted' }, '还没有会话。用手机给 Bot 发一句，再点「拉取消息」。'),
      ]),
      h('section', { key: 'thread', className: 'sm-dsbot-thread' }, [
        h('div', { key: 'th', className: 'sm-dsbot-thread-head' },
          peer ? shortPeer(peer) : '选择左侧会话'),
        peer ? h('button', {
          key: 'older',
          type: 'button',
          className: 'sm-btn sm-dsbot-load-older',
          disabled: chatBusy || !messages.length,
          onClick: () => loadChat(peer, { before: messages[0] && messages[0].at }),
        }, '加载更早') : null,
        h('div', { key: 'msgs', className: 'sm-dsbot-msgs', ref: threadRef },
          peer
            ? (messages.length
              ? messages.map((m) => h('div', {
                key: m.id,
                className: 'sm-dsbot-bubble-row ' + (m.role === 'bot' ? 'bot' : 'user'),
              }, [
                h('div', { key: 'b', className: 'sm-dsbot-bubble' }, m.text),
                h('time', { key: 't' }, formatTime(m.at)),
              ]))
              : h('p', { key: 'empty', className: 'sm-panel-muted' }, chatBusy ? '加载中…' : '此会话暂无记录'))
            : h('p', { key: 'hint', className: 'sm-panel-muted' }, '选中联系人后显示气泡时间线')),
        peer ? h('div', { key: 'composer', className: 'sm-dsbot-composer' }, [
          h('input', {
            key: 'i',
            className: 'sm-panel-input',
            value: sendText,
            disabled: busy,
            placeholder: '回复（需对方先发过消息）',
            onChange: (e) => setSendText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                testSend()
              }
            },
          }),
          h('button', {
            key: 'go', type: 'button', className: 'sm-btn primary', disabled: busy, onClick: testSend,
          }, '发送'),
        ]) : null,
      ]),
    ]),
  ])

  return h('div', { className: 'sm-eng-card sm-dsbot-card', 'data-testid': 'dsbot-card' }, [
    h('header', { key: 'top', className: 'sm-dsbot-top' }, [
      h('h3', { key: 'title', className: 'sm-dsbot-title' }, 'DsBot'),
      h('p', { key: 'lead', className: 'sm-panel-muted' }, '跨端分身：微信官方通道扫码与聊天。'),
    ]),
    platformCols,
    weixinColumn,
    msg ? h('p', { key: 'msg', className: 'sm-panel-muted', style: { marginTop: 10 } }, msg) : null,
  ])
}

module.exports = { DsBotCard }
