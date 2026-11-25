// 自主意图 card for the 作息与主动 tab: the switch that turns the schedule gate into
// opportunities she decides on, plus her daily act budget. Restraint is the product's
// core promise — the copy says so, and points at the inner notebook where it is visible.

const React = require('react')
const { api } = require('./util.mjs')

/** 相处经验：她学到的分寸，读给主人看。只读——删除 memory/experience.json 即忘记。 */
function ExperienceNotes() {
  const [notes, setNotes] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    api('experience').then((r) => { if (alive && r && r.ok) setNotes(Array.isArray(r.notes) ? r.notes : []) })
    return () => { alive = false }
  }, [])
  const h = React.createElement
  if (!notes) return null
  if (!notes.length) {
    return h('p', { key: 'exp-empty', className: 'sm-panel-muted' },
      '相处经验还没沉淀出来：她主动过、你回应过几周之后，这里会出现她记住的分寸。')
  }
  return h('div', { key: 'exp', className: 'sm-exp-notes' }, [
    h('h4', { key: 'h', className: 'sm-exp-h' }, '她记住的相处分寸'),
    ...notes.slice(0, 6).map((n, i) => h('p', { key: 'n' + i, className: 'sm-exp-note' },
      String(n.text || '') + (n.evidence ? '（据 ' + n.evidence + ' 次相处）' : ''))),
  ])
}

function intentSection({ h, proDraft, patchProactive, companionThird }) {
  const pp = companionThird || '她'
  const on = !!(proDraft && proDraft.intentEnabled)
  const acts = Math.max(1, Math.min(8, Number(proDraft && proDraft.intentMaxActsPerDay) || 5))
  return h('div', { key: 'intent', className: 'sm-intent-card' }, [
    h('label', { key: 'on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: on,
        onChange: (e) => patchProactive({ intentEnabled: !!e.target.checked }),
      }),
      h('span', { key: 't' }, '自主意图（' + pp + '自己决定要不要做、做什么）'),
    ]),
    h('p', { key: 'desc', className: 'sm-panel-muted' },
      '开启后，时段问候、刷到的好视频、到期的约定都变成' + pp + '面前的机会——'
      + '按' + pp + '的性格决定接不接。忍住没说的话会写进小本本，翻得到。'),
    on ? h('label', { key: 'acts', className: 'sm-llm-budget-row' }, [
      h('span', { key: 'l' }, '每天最多主动'),
      h('input', {
        key: 'n', type: 'number', min: 1, max: 8, step: 1, value: String(acts),
        onChange: (e) => patchProactive({ intentMaxActsPerDay: Math.max(1, Math.min(8, Number(e.target.value) || 5)) }),
      }),
      h('span', { key: 'u' }, '次'),
    ]) : null,
    on ? h('label', { key: 'exp-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: proDraft.experienceEnabled !== false,
        onChange: (e) => patchProactive({ experienceEnabled: !!e.target.checked }),
      }),
      h('span', { key: 't' }, '相处经验（每周从你的回应里学分寸；不改性格数值）'),
    ]) : null,
    on ? h(ExperienceNotes, { key: 'exp-notes' }) : null,
    on ? h('p', { key: 'note', className: 'sm-panel-muted' },
      '判断用较便宜的模型，安静时段与每日上限照旧；「不动」也是正当选择。') : null,
  ])
}

module.exports = { intentSection }