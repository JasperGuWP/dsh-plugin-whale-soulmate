// 日记 tab：翻《给××的信》与《××的小本本》，条目多时按 年 → 月 → 日 分组。

const React = require('react')
const h = React.createElement
const { companionPronoun, plainMemoryText } = require('./util.mjs')

const GROUP_THRESHOLD = 6

/** Parse YYYY-MM-DD from bookshelf label / id. */
function dateOf(item) {
  const raw = String((item && (item.label || item.id)) || '')
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return { year: '未知', month: '00', day: '00', key: '0000-00-00' }
  return { year: m[1], month: m[2], day: m[3], key: m[1] + '-' + m[2] + '-' + m[3] }
}

function dayLabel(item) {
  const d = dateOf(item)
  const rest = String(item.label || '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, '')
    .replace(/^(to-you|inner)\s*/i, '')
    .trim()
  if (rest && rest !== 'to-you' && rest !== 'inner') return d.day + '日 · ' + rest
  return d.day + '日'
}

/** Nest newest-first into year → month → days. */
function groupByYmd(list) {
  const years = []
  const yearMap = new Map()
  for (const item of list) {
    const d = dateOf(item)
    let y = yearMap.get(d.year)
    if (!y) {
      y = { year: d.year, months: [], monthMap: new Map() }
      yearMap.set(d.year, y)
      years.push(y)
    }
    let m = y.monthMap.get(d.month)
    if (!m) {
      m = { month: d.month, days: [] }
      y.monthMap.set(d.month, m)
      y.months.push(m)
    }
    m.days.push(item)
  }
  return years
}

function diaryCard(p) {
  const hx = p.h || h
  const shelf = p.shelf
  const book = p.book === 'inner' ? 'inner' : 'toYou'
  const notebooks = (shelf && shelf.notebooks) || {}
  const publicTitle = notebooks.publicTitle || '《给你的信》'
  const innerTitle = notebooks.innerTitle || '《小本本》'
  const canInner = !!(shelf && shelf.canReadInnerDiary)
  const g = p.gender === 'male' || p.gender === 'female' ? p.gender : null
  const pp = companionPronoun(g).third
  const list = shelf
    ? (book === 'inner' ? (shelf.inner || []) : (shelf.toYou || [])).slice().reverse()
    : []
  const selected = list.find((it) => it.id === p.selectedId) || list[0] || null
  const grouped = list.length >= GROUP_THRESHOLD
  const tree = grouped ? groupByYmd(list) : null

  const emptyHint = !shelf
    ? '正在翻日记…'
    : book === 'inner'
      ? pp + '还没写私密小本本。'
      : '还没有写给你的信。多聊聊、收个尾，' + pp + '就会记在这里。'

  const itemBtn = (it) => hx('button', {
    key: it.id,
    type: 'button',
    className: 'sm-diary-item' + (selected && selected.id === it.id ? ' on' : ''),
    onClick: () => p.onSelect(it.id),
  }, grouped ? dayLabel(it) : String(it.label || it.id))

  const listNode = !list.length
    ? hx('p', { key: 'empty', className: 'sm-panel-muted' }, emptyHint)
    : hx('div', { key: 'body', className: 'sm-diary-body' }, [
        hx('div', { key: 'list', className: 'sm-diary-list' },
          grouped
            ? tree.map((y) => hx('div', { key: 'y' + y.year, className: 'sm-diary-year' }, [
                hx('div', { key: 'yh', className: 'sm-diary-group' }, y.year + ' 年'),
                ...y.months.map((m) => hx('div', { key: 'm' + m.month, className: 'sm-diary-month' }, [
                  hx('div', { key: 'mh', className: 'sm-diary-group sm-diary-group-m' }, Number(m.month) + ' 月'),
                  ...m.days.map(itemBtn),
                ])),
              ]))
            : list.map(itemBtn)
        ),
        hx('pre', { key: 'paper', className: 'sm-diary-paper' },
          selected
            ? ((canInner || !selected.locked)
              ? (plainMemoryText(selected.content || selected.summary) || '（空白页）')
              : '亲密度还不够，暂时看不了这一页。')
            : ''),
      ])

  return hx('div', { key: 'diary', className: 'sm-eng-card sm-diary-card' }, [
    hx('div', { key: 'head', className: 'sm-eng-head' }, [
      hx('div', { key: 't', className: 'sm-eng-title' }, [
        hx('b', { key: 'h3' }, '日记本'),
        hx('em', { key: 'p' }, grouped
          ? '条目较多，已按年 / 月 / 日归类。'
          : '写给你的信，和' + pp + '自己的小本本。'),
      ]),
    ]),
    hx('div', { key: 'tabs', className: 'sm-diary-tabs' }, [
      hx('button', {
        key: 'toYou',
        type: 'button',
        className: 'sm-diary-tab' + (book === 'toYou' ? ' on' : ''),
        onClick: () => p.onBook('toYou'),
      }, publicTitle + '（' + ((shelf && shelf.toYou && shelf.toYou.length) || 0) + '）'),
      hx('button', {
        key: 'inner',
        type: 'button',
        className: 'sm-diary-tab' + (book === 'inner' ? ' on' : ''),
        onClick: () => p.onBook('inner'),
      }, innerTitle + '（' + ((shelf && shelf.inner && shelf.inner.length) || 0) + '）'),
    ]),
    listNode,
  ])
}

module.exports = { diaryCard, groupByYmd, dateOf, GROUP_THRESHOLD }
