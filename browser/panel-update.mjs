// 设置页头部的自更新徽章:定时拉 update-status(本地 tgz / npm / GitHub Releases 三渠道),
// 有新包显示「更新到 x · 来源」,点击走 self-update(远程包下载校验后 pnpm add),
// 装完显示「重启生效」。无更新时不占位。
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

const CHANNEL_LABELS = { local: '本地包', npm: 'npm', github: 'GitHub Release' }

function UpdateBadge() {
  const [st, setSt] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [rerr, setRerr] = React.useState('')
  function load() {
    api('update-status').then((s) => { if (s && s.ok !== false) setSt(s) }).catch(() => {})
  }
  React.useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [])
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
  if (!st) return null
  if (st.phase === 'installed') {
    return h('div', { key: 'upd', className: 'sm-panel-update' }, [
      h('span', { key: 't', className: 'sm-panel-muted' }, `已装 ${st.current} · 重启生效`),
      h('button', { key: 'b', type: 'button', className: 'sm-panel-btn primary', onClick: doRestart }, '重启'),
      rerr ? h('span', { key: 'e', className: 'sm-panel-muted' }, '重启失败:' + rerr) : null,
    ])
  }
  if (st.phase === 'error') {
    return h('div', { key: 'upd', className: 'sm-panel-update' }, [
      h('span', { key: 't', className: 'sm-panel-muted' }, '更新失败:' + (st.error || '未知')),
      h('button', { key: 'b', type: 'button', className: 'sm-panel-btn', onClick: doUpdate, disabled: busy }, '重试'),
    ])
  }
  if (!st.available) return null
  const via = CHANNEL_LABELS[st.channel] || st.channel || ''
  return h('div', { key: 'upd', className: 'sm-panel-update' }, [
    h('button', {
      key: 'b', type: 'button', className: 'sm-panel-btn primary', onClick: doUpdate, disabled: busy,
      title: via ? `更新来源：${via}${st.channel !== 'local' ? '（下载后先校验再安装）' : ''}` : '',
    }, busy ? (st.channel === 'local' ? '安装中…' : '下载安装中…') : `更新到 ${st.latest}`),
    via ? h('span', { key: 'via', className: 'sm-panel-muted', style: { marginLeft: 6, fontSize: 12 } }, `来源 ${via}`) : null,
  ])
}

module.exports = { UpdateBadge }