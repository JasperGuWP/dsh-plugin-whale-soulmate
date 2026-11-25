// 设置页头部的自更新徽章:常驻显示当前版本+「检查更新」按钮(POST update-check 立即探测三渠道),
// 定时拉 update-status(本地 tgz / npm / GitHub Releases)兜底;有新包显示「更新到 x · 来源」,
// 点击走 self-update(远程包下载校验后 pnpm add),装完显示「重启生效」。
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

const CHANNEL_LABELS = { local: '本地包', npm: 'npm', github: 'GitHub Release' }

function UpdateBadge() {
  const [st, setSt] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [rerr, setRerr] = React.useState('')
  const [note, setNote] = React.useState('')
  function load() {
    api('update-status').then((s) => { if (s && s.ok !== false) setSt(s) }).catch(() => {})
  }
  React.useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [])
  function doCheck() {
    if (checking) return
    setChecking(true)
    setNote('')
    api('update-check', {}).then((s) => {
      setChecking(false)
      if (s && s.ok !== false) {
        setSt(s)
        if (!s.available && s.phase !== 'installed' && s.phase !== 'error') setNote('已是最新')
      } else {
        setNote('检查失败:' + ((s && s.error) || '未知'))
      }
    }).catch(() => { setChecking(false); setNote('检查失败') })
  }
  function doUpdate() {
    if (busy) return
    setBusy(true)
    api('self-update', {}).then(() => { setBusy(false); load() }).catch(() => { setBusy(false); load() })
  }
  function doRestart() {
    api('self-restart', {}).then((r) => {
      if (r && r.ok === false) setRerr(r.error || 'restart failed')
    }).catch(() => setRerr('restart request failed'))
  }
  const versionText = st && st.current ? `v${st.current}` : 'soulmate'
  const checkBtn = h('button', {
    key: 'chk', type: 'button', className: 'sm-panel-btn', onClick: doCheck, disabled: checking,
    title: '立即检查 本地包 / npm / GitHub Release 三渠道',
  }, checking ? '检查中…' : '检查更新')
  const versionSpan = h('span', { key: 'v', className: 'sm-panel-muted', style: { fontSize: 12 } }, versionText)
  const noteSpan = note ? h('span', { key: 'n', className: 'sm-panel-muted', style: { fontSize: 12 } }, note) : null
  if (st && st.phase === 'installed') {
    return h('div', { key: 'upd', className: 'sm-panel-update' }, [
      versionSpan,
      h('span', { key: 't', className: 'sm-panel-muted' }, '重启生效'),
      h('button', { key: 'b', type: 'button', className: 'sm-panel-btn primary', onClick: doRestart }, '重启'),
      rerr ? h('span', { key: 'e', className: 'sm-panel-muted' }, '重启失败:' + rerr) : null,
      checkBtn,
    ])
  }
  if (st && st.phase === 'error') {
    return h('div', { key: 'upd', className: 'sm-panel-update' }, [
      versionSpan,
      h('span', { key: 't', className: 'sm-panel-muted' }, '更新失败:' + (st.error || '未知')),
      h('button', { key: 'b', type: 'button', className: 'sm-panel-btn', onClick: doUpdate, disabled: busy }, '重试'),
      checkBtn,
    ])
  }
  if (st && st.available) {
    const via = CHANNEL_LABELS[st.channel] || st.channel || ''
    return h('div', { key: 'upd', className: 'sm-panel-update' }, [
      versionSpan,
      h('button', {
        key: 'b', type: 'button', className: 'sm-panel-btn primary', onClick: doUpdate, disabled: busy,
        title: via ? `更新来源：${via}${st.channel !== 'local' ? '（下载后先校验再安装）' : ''}` : '',
      }, busy ? (st.channel === 'local' ? '安装中…' : '下载安装中…') : `更新到 ${st.latest}`),
      via ? h('span', { key: 'via', className: 'sm-panel-muted', style: { fontSize: 12 } }, `来源 ${via}`) : null,
      checkBtn,
    ])
  }
  return h('div', { key: 'upd', className: 'sm-panel-update' }, [versionSpan, checkBtn, noteSpan])
}

module.exports = { UpdateBadge }