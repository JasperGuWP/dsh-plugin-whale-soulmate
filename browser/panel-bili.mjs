// Bilibili auth card — talks only to /api/bili/auth (+ /api/config for the write switch).
// QR path shows a real scannable image and auto-polls until confirmed / expired.
// Manual path: three separate boxes (SESSDATA / bili_jct / DedeUserID) with per-field how-to.
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

const QR_POLL_MS = 2000

function statusLabel(s) {
  if (s === 'pending') return '等待扫码…'
  if (s === 'scanned') return '已扫码，请在手机上确认'
  if (s === 'expired') return '二维码已过期，请重新获取'
  if (s === 'confirmed') return '登录成功'
  return s ? String(s) : ''
}

/** One credential box: label + how-to hint + input. */
function credField(key, label, hint, placeholder, value, onChange, opts = {}) {
  return h('label', { key, className: 'sm-field sm-bili-cred', style: { display: 'block', marginTop: 10 } }, [
    h('span', { key: 'l', className: 'sm-bili-cred-label' }, [
      h('b', { key: 'n' }, label),
      opts.optional ? h('i', { key: 'o', className: 'sm-panel-muted' }, '（选填）') : null,
    ]),
    h('p', { key: 'h', className: 'sm-panel-muted sm-bili-cred-hint' }, hint),
    h('input', {
      key: 'i',
      type: opts.secret ? 'password' : 'text',
      className: 'sm-input',
      style: { width: '100%', marginTop: 4 },
      value,
      placeholder,
      autoComplete: 'off',
      spellCheck: false,
      onChange: (e) => onChange(e.target.value),
    }),
  ])
}

function biliAuthCard() {
  const [status, setStatus] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [sessdata, setSessdata] = React.useState('')
  const [jct, setJct] = React.useState('')
  const [uid, setUid] = React.useState('')
  const [writeOn, setWriteOn] = React.useState(false)
  const [qr, setQr] = React.useState(null) // { qrcodeKey, url, qrDataUrl, pollStatus }
  const qrRef = React.useRef(null)
  qrRef.current = qr

  const refresh = React.useCallback(() => {
    api('bili/auth').then((s) => {
      if (s && s.ok !== false) setStatus(s)
    }).catch(() => {})
    api('config').then((c) => {
      if (c && c.extensions) setWriteOn(c.extensions.biliWriteEnabled === true)
    }).catch(() => {})
  }, [])

  React.useEffect(() => { refresh() }, [refresh])

  // Auto-poll while a QR session is live.
  React.useEffect(() => {
    if (!qr?.qrcodeKey || qr.pollStatus === 'confirmed' || qr.pollStatus === 'expired') return undefined
    let alive = true
    const tick = async () => {
      if (!alive || !qrRef.current?.qrcodeKey) return
      const key = qrRef.current.qrcodeKey
      try {
        const res = await api('bili/auth', { action: 'qr_poll', qrcodeKey: key })
        if (!alive || qrRef.current?.qrcodeKey !== key) return
        if (!res || res.ok === false) {
          setMsg(res?.error || '轮询失败')
          return
        }
        if (res.status === 'confirmed') {
          setQr(null)
          setMsg(`已登录 ${res.uname || ''}`.trim())
          refresh()
          return
        }
        setQr((prev) => (prev && prev.qrcodeKey === key ? { ...prev, pollStatus: res.status } : prev))
        setMsg(statusLabel(res.status))
        if (res.status === 'expired') return
      } catch (err) {
        if (alive) setMsg(err?.message || String(err))
      }
    }
    const id = setInterval(tick, QR_POLL_MS)
    tick()
    return () => { alive = false; clearInterval(id) }
  }, [qr?.qrcodeKey, refresh])

  async function run(action, body = {}) {
    setBusy(true)
    if (action !== 'qr_poll') setMsg('')
    try {
      const res = await api('bili/auth', { action, ...body })
      if (!res || res.ok === false) {
        setMsg(res?.error || '失败')
        return res
      }
      if (action === 'qr_start') {
        setQr({
          qrcodeKey: res.qrcodeKey,
          url: res.url,
          qrDataUrl: res.qrDataUrl || '',
          pollStatus: 'pending',
        })
        setMsg('请用手机 B 站 App 扫码（约 3 分钟有效）')
        return res
      }
      if (action === 'qr_poll') {
        if (res.status === 'confirmed') {
          setQr(null)
          setMsg(`已登录 ${res.uname || ''}`.trim())
          refresh()
        } else {
          setQr((prev) => (prev ? { ...prev, pollStatus: res.status } : prev))
          setMsg(statusLabel(res.status))
        }
        return res
      }
      setMsg(res.uname ? `已登录 ${res.uname}` : (res.loggedIn === false ? '已清除 / 未登录' : '完成'))
      refresh()
      return res
    } catch (err) {
      setMsg(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveCreds() {
    const res = await run('configure_cookie', {
      sessdata: sessdata.trim(),
      biliJct: jct.trim(),
      uid: uid.trim(),
    })
    if (res?.ok) { setSessdata(''); setJct(''); setUid('') }
  }

  async function toggleWrite(on) {
    setWriteOn(on)
    try {
      await api('config', { extensions: { biliWriteEnabled: on } })
      setMsg(on ? '写操作已开启：私信 / 评论 / 弹幕 / 点赞 / 投币 / 收藏 / 关注 / 改资料 / 开播 / 投稿。' : '写操作已关闭。')
    } catch (err) {
      setWriteOn(!on)
      setMsg(err?.message || String(err))
    }
  }

  const line = status
    ? (status.loggedIn
      ? `已登录 ${status.uname || status.uidMasked || ''}`.trim()
      : '未登录 · 无号也可看片；登录后接口更稳，并可开分享与写操作')
    : '读取中…'

  const canSave = sessdata.trim() && jct.trim()

  return h('section', { className: 'sm-eng-card sm-bili-auth', 'data-testid': 'bili-auth-card' }, [
    h('header', { key: 'h', className: 'sm-eng-head' }, [
      h('span', { key: 'n', className: 'sm-eng-num' }, 'B站'),
      h('div', { key: 't' }, [
        h('h3', { key: 'title' }, 'B 站登录'),
        h('p', { key: 's', className: 'sm-panel-muted' }, line),
      ]),
    ]),
    h('div', { key: 'actions', className: 'sm-row', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } }, [
      h('button', {
        key: 'qr',
        type: 'button',
        className: 'sm-btn',
        disabled: busy,
        onClick: () => run('qr_start'),
      }, qr ? '刷新二维码' : '扫码登录'),
      h('button', {
        key: 'verify',
        type: 'button',
        className: 'sm-btn',
        disabled: busy,
        onClick: () => run('verify'),
      }, '自检'),
      h('button', {
        key: 'clear',
        type: 'button',
        className: 'sm-btn',
        disabled: busy || !status?.loggedIn,
        onClick: () => run('clear'),
      }, '退出'),
    ]),
    qr ? h('div', {
      key: 'qrbox',
      style: {
        marginTop: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
      },
    }, [
      qr.qrDataUrl
        ? h('img', {
          key: 'img',
          src: qr.qrDataUrl,
          width: 200,
          height: 200,
          alt: 'B站登录二维码',
          style: { borderRadius: 8, background: '#fff', padding: 8, boxSizing: 'content-box' },
        })
        : h('p', { key: 'fallback', className: 'sm-panel-muted' }, [
          '二维码图生成失败，请 ',
          h('a', { key: 'a', href: qr.url, target: '_blank', rel: 'noreferrer' }, '打开链接'),
          ' 后用其它工具生成二维码',
        ]),
      h('p', { key: 'hint', className: 'sm-panel-muted' }, statusLabel(qr.pollStatus) || '等待扫码…'),
      h('button', {
        key: 'cancel',
        type: 'button',
        className: 'sm-btn',
        disabled: busy,
        onClick: () => { setQr(null); setMsg('') },
      }, '取消扫码'),
    ]) : null,
    h('div', { key: 'manual', className: 'sm-bili-manual' }, [
      h('p', { key: 'lead', className: 'sm-panel-muted sm-bili-manual-lead' },
        '或不扫码，手动填三项。取法：电脑浏览器打开并登录 bilibili.com → 按 F12 → Application（应用）→ 左侧 Cookies → https://www.bilibili.com → 在右侧表里找下面三个名字，复制 Value 列。'),
      credField('sessdata', 'SESSDATA', '登录态本体。在 Cookies 表里找 SESSDATA，复制它的 Value（很长一串，含 % 号）。', '粘贴 SESSDATA 的 Value', sessdata, setSessdata, { secret: true }),
      credField('jct', 'bili_jct', 'CSRF 令牌，写操作（评论 / 点赞 / 私信…）必需。找 bili_jct，复制 Value（32 位）。', '粘贴 bili_jct 的 Value', jct, setJct, { secret: true }),
      credField('uid', 'DedeUserID', '你的 UID（纯数字）。找 DedeUserID，复制 Value；也可在 B 站个人空间网址里看到。', '粘贴 DedeUserID 的 Value', uid, setUid),
      h('div', { key: 'cookie-actions', style: { marginTop: 10 } }, [
        h('button', {
          key: 'save',
          type: 'button',
          className: 'sm-btn',
          disabled: busy || !canSave,
          onClick: saveCreds,
        }, '保存并校验'),
        h('span', { key: 'need', className: 'sm-panel-muted', style: { marginLeft: 8 } },
          canSave ? '保存时会在线校验，失败不覆盖旧凭据。' : '至少填 SESSDATA 与 bili_jct。'),
      ]),
    ]),
    h('div', { key: 'write', className: 'sm-bili-write' }, [
      h('label', { key: 'on', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: writeOn,
          disabled: !status?.loggedIn,
          onChange: (e) => toggleWrite(e.target.checked),
        }),
        h('span', { key: 't' }, '允许 B 站写操作（私信 / 评论 / 弹幕 / 点赞 / 投币 / 收藏 / 关注 / 改资料 / 开播 / 投稿）'),
      ]),
      h('p', { key: 'hint', className: 'sm-panel-muted' },
        status?.loggedIn
          ? '默认关闭。开启后仍受护栏约束：隐私防火墙、每日 20 次、两次间隔 30 秒、全程审计；密钥永不回显。'
          : '先登录，才能开启写操作。'),
    ]),
    msg ? h('p', { key: 'msg', className: 'sm-panel-muted', style: { marginTop: 8 } }, msg) : null,
  ])
}

module.exports = { biliAuthCard }
