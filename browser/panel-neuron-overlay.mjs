// 全屏星图覆盖层：点「放大」立刻可见，不依赖 Electron 进程。
// 覆盖层里的「独立窗口」按钮才走 neuron-window 路由；成功/失败都会显示在原位。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')
const { drawNeurons, noteEvents, progressActive } = require('./neuron/index.mjs')

function fitFull(canvas) {
  if (!canvas) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const wpx = Math.max(320, Math.round((canvas.clientWidth || window.innerWidth) * dpr))
  const hpx = Math.max(240, Math.round((canvas.clientHeight || window.innerHeight) * dpr))
  if (canvas.width !== wpx || canvas.height !== hpx) { canvas.width = wpx; canvas.height = hpx }
}

function NeuronOverlay({ open, onClose }) {
  const canvasRef = React.useRef(null)
  const graphRef = React.useRef(null)
  const [status, setStatus] = React.useState('')
  const [title, setTitle] = React.useState('记忆星空')

  React.useEffect(() => {
    if (!open) return undefined
    let alive = true
    let since = 0
    let seeded = false
    const fit = () => fitFull(canvasRef.current)
    fit()
    const onResize = () => fit()
    window.addEventListener('resize', onResize)
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const refreshHud = () => {
      const g = graphRef.current
      const n = g && Array.isArray(g.nodes) ? g.nodes.length : 0
      const working = canvasRef.current && progressActive(canvasRef.current)
      setTitle('记忆星空 · ' + n + ' 颗星' + (working ? ' · 正在整理记忆…' : ''))
    }
    const poll = () => {
      api('neural-graph?since=' + since).then((g) => {
        if (!alive || !g || g.ok === false) return
        graphRef.current = g
        // Seed cursor only on first fetch — historical events must not ignite soft
        // birth/flash glows every time the overlay remounts.
        if (seeded && canvasRef.current && Array.isArray(g.events) && g.events.length) {
          noteEvents(canvasRef.current, g.events, Date.now())
        }
        if (g.eventSeq) since = g.eventSeq
        seeded = true
        refreshHud()
      })
    }
    poll()
    const timer = setInterval(poll, 6000)
    const hudTimer = setInterval(() => { if (alive) refreshHud() }, 1000)
    let raf = 0
    const tick = (time) => {
      if (canvasRef.current) drawNeurons(canvasRef.current, graphRef.current, time)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      clearInterval(timer)
      clearInterval(hudTimer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  const openWindow = () => {
    setStatus('正在打开独立窗口…')
    api('neuron-window/open', {}).then((r) => {
      setStatus(r && r.ok ? '独立窗口已打开' : ('独立窗口打开失败：' + ((r && r.error) || '未知原因')))
    })
  }
  return h('div', { key: 'sky-overlay', className: 'sm-sky-overlay' }, [
    h('div', { key: 'bar', className: 'sm-sky-bar' }, [
      h('b', { key: 't' }, title),
      h('span', { key: 's', className: 'sm-sky-status' }, status),
      h('div', { key: 'actions', className: 'sm-sky-actions' }, [
        h('button', { key: 'win', type: 'button', className: 'sm-btn', onClick: openWindow }, '独立窗口'),
        h('button', {
          key: 'close', type: 'button', className: 'sm-btn sm-sky-close', onClick: onClose, title: 'Esc 关闭',
        }, ['关闭', h('span', { key: 'kbd', className: 'sm-sky-kbd' }, 'Esc')]),
      ]),
    ]),
    h('canvas', { key: 'canvas', ref: canvasRef, className: 'sm-sky-full' }),
    h('p', { key: 'hint', className: 'sm-sky-hint' }, '拖动旋转 · 滚轮缩放 · 单击查看 · 双击飞近 · 双击空白回到全景'),
  ])
}

module.exports = { NeuronOverlay }
