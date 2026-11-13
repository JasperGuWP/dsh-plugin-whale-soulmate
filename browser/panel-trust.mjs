// Trust card for 状态总览: conflicts, promises, presence digest.
const React = require('react')
const h = React.createElement
const { engHead, TRUST_HINTS } = require('./panel-cards.mjs')

const promiseStatusWord = { made: '待兑现', kept: '已兑现', broken: '失约', released: '已作废' }

function trustCard({ trust, presence, trustAct }) {
  const t = trust || { promises: [], conflicts: [] }
  const p = presence || { text: '' }
  return h('div', { key: 'trust', className: 'sm-eng-card', title: TRUST_HINTS.card }, [
    engHead('04', '约定与近况', '承诺 · 待确认 · 她记得的事', ''),
    t.conflicts.length
      ? h('div', { key: 'cf', className: 'sm-eng-clauses', title: TRUST_HINTS.conflicts }, t.conflicts.slice(0, 3).map((c, i) =>
          h('div', { key: 'c' + i, className: 'sm-eng-clause', title: TRUST_HINTS.conflicts }, [
            h('span', null, '旧：' + (c.older.text || '?') + ' ／ 新：' + c.newer.text),
            h('span', { key: 'acts' }, [
              h('button', { key: 'kn', type: 'button', title: '保留较新的那条', onClick: () => trustAct('conflicts', { keepId: c.newer.id, dropId: c.older.id, reason: '面板选择' }) }, '保留新'),
              h('button', { key: 'ko', type: 'button', title: '保留较旧的那条', onClick: () => trustAct('conflicts', { keepId: c.older.id, dropId: c.newer.id, reason: '面板选择' }) }, '保留旧'),
            ]),
          ])
        ))
      : h('p', { key: 'ncf', className: 'sm-panel-muted', title: TRUST_HINTS.noConflicts }, '没有需要你拍板的记忆冲突。'),
    t.promises.length
      ? h('div', { key: 'pm', className: 'sm-eng-clauses', title: TRUST_HINTS.promises }, t.promises.slice(0, 5).map((pm) =>
          h('div', { key: pm.id, className: 'sm-eng-clause', title: TRUST_HINTS.promises }, [
            h('span', null,
              (pm.status === 'made'
                ? (pm.overdueDays > 0 ? '⚠ 逾期 ' + pm.overdueDays + ' 天 · ' : '待兑现 · ')
                : ((promiseStatusWord[pm.status] || '承诺') + ' · '))
              + pm.text),
            pm.status === 'made'
              ? h('span', { key: 'acts' }, [
                  h('button', { key: 'k', type: 'button', title: '标记为已兑现', onClick: () => trustAct('promises', { id: pm.id, action: 'keep' }) }, '兑现'),
                  h('button', { key: 'b', type: 'button', title: '标记为失约', onClick: () => trustAct('promises', { id: pm.id, action: 'break' }) }, '失约'),
                  h('button', { key: 'r', type: 'button', title: '作废，不再催', onClick: () => trustAct('promises', { id: pm.id, action: 'release' }) }, '作废'),
                ])
              : null,
          ])
        ))
      : h('p', { key: 'npm', className: 'sm-panel-muted', title: TRUST_HINTS.noPromises }, '还没有未了的承诺。'),
    h('pre', { key: 'presence', className: 'sm-eng-note', style: { whiteSpace: 'pre-wrap' }, title: TRUST_HINTS.presence },
      p.text || '她还没有常挂在心上的事——聊几句偏好就会出现在这里。'),
  ])
}

module.exports = { trustCard }
