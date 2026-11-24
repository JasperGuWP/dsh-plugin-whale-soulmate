// QQ Bot column — reuses the official @tencent-connect/dsh-qqbot host routes.
// The official package ships as a soulmate dependency (see cordis.patch.yml),
// so this column only renders its bind state machine over same-origin fetch;
// config editing stays in the official settings panel.

const React = require('react')
const h = React.createElement

const QQ_API = '/qqbot/im-qqbot/'
const BIND_POLL_MS = 2000

/** Same-origin JSON helper for the official bind routes (plain fetch, Desktop-verified). */
async function qqApi(path, body) {
  try {
    const init = body === undefined
      ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const res = await fetch(QQ_API + path, init)
    const text = await res.text()
    if (!text) {
      return { ok: false, error: '空响应 HTTP ' + res.status + '（QQ bot 路由未挂上，通常需重启 DSH）' }
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      return { ok: false, error: '非 JSON HTTP ' + res.status + '：' + text.slice(0, 120) }
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

/** Wire phases per official lib/shared/bind-protocol: starting/waiting/saving/failed/bound. */
function phaseLabel(state) {
  if (!state) return '加载中…'
  switch (state.phase) {
    case 'starting': return '正在生成二维码…'
    case 'waiting': return '请用手机 QQ 扫码授权'
    case 'saving': return '已扫码，正在保存凭据…'
    case 'failed': return '绑定失败：' + (state.reason || '未知原因')
    case 'bound': return '已绑定 · AppID ' + state.appId
    default: return '状态：' + state.phase
  }
}

/** One-line echo of the masked config GET (appSecret never comes back). */
function configSummary(config) {
  if (!config) return ''
  const model = [config.provider, config.model].filter(Boolean).join(' / ')
  const mention = config.requireMention === false ? '群聊无需 @' : '群聊需 @'
  return (model ? '模型 ' + model : '模型跟随 DSH 最近选择') + ' · ' + mention
}

function QqBotColumn({ onSynced } = {}) {
  const [bind, setBind] = React.useState(null)
  const [config, setConfig] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [syncing, setSyncing] = React.useState(false)

  // 「拉取最新」：立即跑一次 QQ 桥接（官方会话 → 时间线/星图），不等 2 分钟 tick。
  const syncNow = async () => {
    if (syncing) return
    setSyncing(true)
    setMsg('正在拉取最新对话…')
    try {
      const { api } = require('./util.mjs')
      const res = await api('qqbot/sync', {})
      if (res && res.ok) {
        setMsg(res.imported > 0 ? ('已拉取 ' + res.imported + ' 条新消息。') : '已是最新，没有新消息。')
        if (typeof onSynced === 'function') onSynced()
      } else {
        setMsg((res && (res.error || res.reason)) || '拉取失败')
      }
    } catch (err) {
      setMsg(err && err.message ? err.message : '拉取失败')
    } finally {
      setSyncing(false)
    }
  }

  const refresh = React.useCallback(async () => {
    const res = await qqApi('bind')
    if (res && res.phase) {
      setBind(res)
      return res
    }
    setMsg((res && res.error) || '读不到 QQ 绑定状态')
    return null
  }, [])

  const loadConfig = React.useCallback(async () => {
    const res = await qqApi('config')
    if (res && res.config) setConfig(res.config)
  }, [])

  React.useEffect(() => {
    refresh().catch(() => {})
    loadConfig().catch(() => {})
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while unbound: QR issuance, expiry auto-refresh and scan progress all
  // converge through the state endpoint; stop once bound or failed.
  React.useEffect(() => {
    const phase = bind && bind.phase
    if (!phase || phase === 'bound' || phase === 'failed') return undefined
    let alive = true
    const id = setInterval(async () => {
      if (!alive) return
      const res = await qqApi('bind')
      if (alive && res && res.phase) setBind(res)
    }, BIND_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [bind && bind.phase]) // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshQr() {
    setBusy(true)
    setMsg('')
    try {
      const res = await qqApi('bind/refresh', {})
      if (res && res.phase) {
        setBind(res)
        setMsg('正在刷新二维码…')
      } else {
        setMsg((res && res.error) || '刷新二维码失败')
      }
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    setBusy(true)
    setMsg('解绑中…')
    try {
      const res = await qqApi('bind/unbind', {})
      if (res && res.ok) {
        setMsg(res.message || '已解绑，插件将自动重载')
        // HMR reload re-enters the bind flow; polling converges to the new QR.
        setBind({ phase: 'starting' })
      } else {
        setMsg((res && res.error) || '解绑失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const phase = bind && bind.phase
  const bound = phase === 'bound'
  const waiting = phase === 'waiting'
  const summary = configSummary(config)

  return h('div', { className: 'sm-dsbot-column', 'data-platform': 'qqbot' }, [
    h('header', { key: 'h', className: 'sm-dsbot-column-head' }, [
      h('span', { key: 'badge', className: 'sm-dsbot-plat-badge lg' }, 'QQ'),
      h('div', { key: 't' }, [
        h('h3', { key: 'title' }, 'QQ 官方 · 开放平台 Bot'),
        h('p', { key: 's', className: 'sm-panel-muted' },
          bound
            ? ('已绑定 · AppID ' + bind.appId + (summary ? ' · ' + summary : ''))
            : '扫码授权；按人设回复；别人在 QQ 里跟它聊天。'),
      ]),
    ]),

    h('p', { key: 'note', className: 'sm-panel-muted sm-dsbot-note' },
      '正规通道：QQ 开放平台官方 Bot。绑定后私聊或群里 @ 它即可对话。'),

    h('div', { key: 'actions', className: 'sm-row sm-dsbot-actions' }, [
      h('button', {
        key: 'qr', type: 'button', className: 'sm-btn primary', disabled: busy || bound, onClick: refreshQr,
      }, waiting ? '刷新二维码' : '获取二维码'),
      h('button', {
        key: 'ref', type: 'button', className: 'sm-btn', disabled: busy,
        onClick: () => { refresh(); loadConfig() },
      }, '刷新'),
      h('button', {
        key: 'sync', type: 'button', className: 'sm-btn', disabled: syncing,
        onClick: syncNow,
      }, syncing ? '拉取中…' : '拉取最新'),
      bound ? h('button', {
        key: 'out', type: 'button', className: 'sm-btn', disabled: busy, onClick: unbind,
      }, '解绑') : null,
    ]),

    waiting ? h('div', { key: 'qrbox', className: 'sm-dsbot-qr' }, [
      bind.qrSvg
        ? h('img', {
          key: 'img', src: bind.qrSvg, width: 200, height: 200, alt: 'QQ Bot 绑定二维码',
        })
        : h('p', { key: 'fallback', className: 'sm-panel-muted' }, '二维码图生成中，请稍候…'),
      h('p', { key: 'hint', className: 'sm-panel-muted' }, phaseLabel(bind)),
      bind.url ? h('a', {
        key: 'link', href: bind.url, target: '_blank', rel: 'noreferrer', className: 'sm-panel-muted',
      }, '二维码显示异常？打开绑定链接') : null,
    ]) : null,

    phase && phase !== 'waiting' && phase !== 'bound'
      ? h('p', { key: 'phase', className: 'sm-panel-muted' }, phaseLabel(bind))
      : null,

    msg ? h('p', { key: 'msg', className: 'sm-panel-muted' }, msg) : null,
  ])
}

module.exports = { QqBotColumn, qqApi, phaseLabel, configSummary }
