// 星图轨迹带:按周回放她的成长快照(五维变化/星数/新增主题),点一周把星空过滤回那周。
// 数据从 growth.jsonl 来,每周门跑一次落一条;历史没有就是没有,第一周起积累。

const React = require('react')
const h = React.createElement

const TRAIT_SHORT = {
  clinginess: '黏人',
  sassiness: '吐槽',
  curiosity: '好奇',
  brevity: '简短',
  tsundere: '傲娇',
}

/** 相邻两周的五维差,只列真正动了的维度。 */
function traitDeltas(prev, cur) {
  const out = []
  const a = (prev && prev.traits) || {}
  const b = (cur && cur.traits) || {}
  for (const k of Object.keys(TRAIT_SHORT)) {
    const d = (Number(b[k]) || 0) - (Number(a[k]) || 0)
    if (d !== 0) out.push(TRAIT_SHORT[k] + (d > 0 ? ' +' : ' ') + d)
  }
  return out
}

/** 把星图过滤回某周快照之后存在的星(按 createdAt;没有 createdAt 的老星保留)。 */
function filterGraphToWeek(graph, weekRow) {
  if (!graph || !weekRow) return graph
  const cutoff = Date.parse(weekRow.at || '')
  if (!Number.isFinite(cutoff)) return graph
  const nodes = (graph.nodes || []).filter((n) => {
    const born = Date.parse(n.createdAt || '')
    return !Number.isFinite(born) || born <= cutoff
  })
  const ids = new Set(nodes.map((n) => n.id))
  const synapses = (graph.synapses || []).filter((s) => ids.has(s.source) && ids.has(s.target))
  return Object.assign({}, graph, { nodes, synapses })
}

function growthStrip({ weeks, selectedWeek, onSelect }) {
  const list = Array.isArray(weeks) ? weeks : []
  if (!list.length) {
    return h('p', { key: 'empty', className: 'sm-panel-muted' },
      '成长轨迹从本周开始积累:每周整理跑完会存一份快照,之后就能按周回看她的星座怎么长出来。')
  }
  return h('div', { key: 'strip', className: 'sm-growth-strip' }, [
    h('button', {
      key: 'now', type: 'button',
      className: 'sm-growth-week' + (selectedWeek ? '' : ' sm-growth-week-on'),
      title: '回到当前完整星空（取消按周回看）',
      onClick: () => onSelect(null),
    }, [
      h('b', { key: 'w' }, '现在'),
      h('span', { key: 'n' }, '完整星空'),
    ]),
    ...list.map((w, i) => {
      const deltas = traitDeltas(list[i - 1], w)
      const on = selectedWeek === w.week
      return h('button', {
        key: w.week, type: 'button',
        className: 'sm-growth-week' + (on ? ' sm-growth-week-on' : ''),
        title: '点击把星空回放到这一周；' + (deltas.length ? '当周性格变化：' + deltas.join(' · ') : '这一周性格没有变化'),
        onClick: () => onSelect(on ? null : w.week),
      }, [
        h('b', { key: 'w' }, String(w.week).slice(5) + ' 周'),
        h('span', { key: 'n' }, (w.nodes || 0) + ' 星'),
        deltas.length ? h('span', { key: 'd', className: 'sm-growth-delta' }, deltas.join(' ')) : null,
      ])
    }),
  ])
}

module.exports = { growthStrip, filterGraphToWeek, traitDeltas }