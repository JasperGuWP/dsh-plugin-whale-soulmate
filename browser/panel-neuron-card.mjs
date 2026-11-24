// 记忆星图卡：自包含（轮询/绘制/成长轨迹/全屏放大），面板只传 mem 与提示回调。
// 全屏「放大」走面板内覆盖层——不依赖 Electron 窗口，点击立刻有反应；
// 覆盖层里再提供「独立窗口」按钮走 neuron-window 路由（失败会明示原因）。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')
const { drawNeurons, noteEvents, fitNeuronCanvas } = require('./neuron/index.mjs')
const { engHead } = require('./panel-cards.mjs')
const { growthStrip, filterGraphToWeek } = require('./panel-neuron-growth.mjs')
const { NeuronOverlay } = require('./panel-neuron-overlay.mjs')

function NeuronCard({ mem, onNote }) {
  const [graph, setGraph] = React.useState(null)
  const [weeks, setWeeks] = React.useState([])
  const [week, setWeek] = React.useState(null)
  const [full, setFull] = React.useState(false)
  const canvasRef = React.useRef(null)
  const graphRef = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    let since = 0
    let seeded = false
    const fit = () => fitNeuronCanvas(canvasRef.current)
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    if (ro && canvasRef.current) ro.observe(canvasRef.current)
    const fetchGraph = () => {
      api('neural-graph?since=' + since).then((g) => {
        if (!alive || !g || g.ok === false) return
        setGraph(g)
        // First paint only advances the cursor — replaying history as births/flashes
        // is the soft blur-glow that showed up every time the sky opened.
        if (seeded && canvasRef.current && Array.isArray(g.events) && g.events.length) {
          noteEvents(canvasRef.current, g.events, Date.now())
        }
        if (g.eventSeq) since = g.eventSeq
        seeded = true
      })
    }
    fetchGraph()
    api('growth').then((g) => { if (alive && g && g.ok && Array.isArray(g.weeks)) setWeeks(g.weeks) })
    const timer = setInterval(fetchGraph, 15000)
    return () => { alive = false; clearInterval(timer); if (ro) ro.disconnect() }
  }, [])

  graphRef.current = week ? filterGraphToWeek(graph, weeks.find((w) => w.week === week)) : graph

  React.useEffect(() => {
    let raf = 0
    const tick = (time) => {
      if (canvasRef.current) drawNeurons(canvasRef.current, graphRef.current, time)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return h('div', { key: 'neurons', className: 'sm-eng-card' }, [
    engHead('05', '记忆星图', '点与连线', ''),
    h('div', { key: 'lead', className: 'sm-neuron-lead' }, [
      h('span', { key: 'k' }, '记忆点'),
      h('b', { key: 'v' }, String((mem.facts || 0) + (mem.wiki || 0))),
      h('span', { key: 'k2' }, '日记'),
      h('b', { key: 'v2' }, String((mem.episodes || 0))),
      h('button', {
        key: 'pop', type: 'button', className: 'sm-btn sm-neuron-pop',
        title: '全屏查看星图',
        onClick: () => {
          setFull(true)
          if (typeof onNote === 'function') onNote('星图已全屏')
        },
      }, '放大 ⤢'),
    ]),
    h('canvas', {
      key: 'canvas', ref: canvasRef, className: 'sm-neuron-canvas',
      width: 720, height: 360,
    }),
    growthStrip({ weeks, selectedWeek: week, onSelect: setWeek }),
    h('p', { key: 'note', className: 'sm-eng-note' }, '拖动旋转，滚轮缩放；单击查看，双击飞近，双击空白回到全景。夜里整理记忆时，新星会在这里点亮。'),
    h(NeuronOverlay, { key: 'overlay', open: full, onClose: () => setFull(false) }),
  ])
}

module.exports = { NeuronCard }