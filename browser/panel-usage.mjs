// 用量统计：今日消耗、近 7 天趋势、分类明细、每日自动额度。

const React = require('react')
const h = React.createElement

const K = {
  auto: '自动',
  user: 'Bot对话',
}

const KIND_LABEL = {
  proactive: '主动搭话',
  boot: '开机问候',
  handoff: '窗满交接',
  im: '跨端消息',
  dream: '夜里整理',
  distill: '周记整理',
  reflection: '反思',
  chat: '普通对话',
  tool: '工具',
}

const fmt = (n) => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 10_000) return (v / 1000).toFixed(1) + 'k'
  return String(Math.round(v))
}

function sparkline(trend) {
  const list = Array.isArray(trend) ? trend : []
  if (!list.length) return null
  const max = Math.max(1, ...list.map((d) => Number(d.totalTokens) || 0))
  return h('div', { key: 'spark', className: 'sm-usage-spark' }, [
    h('div', { key: 'bars', className: 'sm-usage-bars' }, list.map((d, i) =>
      h('div', {
        key: 'b' + i,
        className: 'sm-usage-bar' + (Number(d.blocked) > 0 ? ' blocked' : ''),
        title: `${d.dateKey}：用量 ${fmt(d.totalTokens)}（自动 ${fmt(d.autoTokens)}／Bot对话 ${fmt(d.userTokens)}）`,
      }, h('i', { style: { height: Math.max(2, Math.round(((Number(d.totalTokens) || 0) / max) * 100)) + '%' } }))
    )),
    h('div', { key: 'labels', className: 'sm-usage-days' }, list.map((d, i) =>
      h('span', { key: 'l' + i }, String(d.dateKey || '').slice(5).replace(/^0/, '') || '—')
    )),
  ])
}

function usageCard(p) {
  const { usage, draft, onDraft, onSave, busy, note, h: hh } = p
  const hx = hh || h
  const u = usage || {}
  const today = u.today || {}
  const cap = u.cap || {}
  const cfg = u.config || {}
  const d = draft || { dailyAutoTokenCap: cfg.dailyAutoTokenCap ?? 2000000, onCapReached: cfg.onCapReached || 'block' }

  const unlimited = Boolean(cap.unlimited)
  const pct = unlimited || !cap.limit ? 0 : Math.min(100, Math.round((Number(cap.used) / Number(cap.limit)) * 100))
  const sessionChat = u.sessionChat || {}

  const field = (label, hint, node) => hx('label', { key: label, className: 'sm-form-row' }, [
    hx('span', { key: 'l', className: 'sm-form-label' }, label),
    node,
    hint ? hx('span', { key: 'h', className: 'sm-panel-muted sm-form-hint' }, hint) : null,
  ])

  return hx('div', { key: 'usage', className: 'sm-eng-card sm-usage-card' }, [
    hx('div', { key: 'head', className: 'sm-eng-head' }, [
      hx('div', { key: 't', className: 'sm-eng-title' }, [
        hx('b', { key: 'h3' }, '用量统计'),
        hx('em', { key: 'p' }, '自动调用记在这里；专属对话窗可看对话页的「统计」。'),
      ]),
    ]),

    hx('div', { key: 'today', className: 'sm-usage-totals' }, [
      hx('div', { key: 'all', className: 'sm-usage-big' }, [
        hx('span', { key: 'l' }, '今日自动用量'),
        hx('b', { key: 'v' }, fmt(today.totalTokens)),
      ]),
      hx('div', { key: 'auto', className: 'sm-usage-sub' }, [
        hx('span', null, '自动 ' + fmt(today.autoTokens)),
        hx('span', null, 'Bot对话 ' + fmt(today.userTokens)),
        hx('span', null, '调用 ' + String(today.calls || 0) + ' 次'),
        Number(today.blocked) > 0 ? hx('span', { className: 'warn' }, '拦截 ' + String(today.blocked) + ' 次') : null,
      ]),
      sessionChat && sessionChat.ok
        ? hx('div', { key: 'sess', className: 'sm-usage-sub' }, [
            hx('span', null, '专属对话窗 ' + fmt(sessionChat.totalTokens)),
            hx('span', null, String(sessionChat.turns || 0) + ' 轮'),
          ])
        : hx('div', { key: 'sess-miss', className: 'sm-usage-sub' }, [
            hx('span', null, '专属对话窗用量暂读不到，可看对话页「统计」'),
          ]),
    ]),

    hx('div', { key: 'cap', className: 'sm-usage-cap' }, [
      hx('div', { key: 'row', className: 'sm-usage-cap-row' }, [
        hx('span', null, unlimited ? '自动额度：不限额' : `自动额度 ${fmt(cap.used)} / ${fmt(cap.limit)}`),
        unlimited ? null : hx('b', { key: 'p', className: pct >= 100 ? 'warn' : 'ok' }, pct + '%'),
      ]),
      unlimited
        ? null
        : hx('div', { key: 'track', className: 'sm-usage-track' }, hx('i', { className: pct >= 100 ? 'warn' : '', style: { width: pct + '%' } })),
      cap.reached ? hx('p', { key: 'hit', className: 'sm-panel-muted warn' }, '今日自动额度已用完，主动搭话会停到明天；你自己发起的不受影响。') : null,
    ]),

    sparkline(u.trend),

    Array.isArray(today.byKind) && today.byKind.length
      ? hx('div', { key: 'kinds', className: 'sm-usage-kinds' }, today.byKind.map((k) =>
          hx('div', { key: k.kind, className: 'sm-usage-kind' }, [
            hx('span', { key: 'n' }, KIND_LABEL[k.kind] || k.kind),
            hx('span', { key: 'v' }, fmt(k.totalTokens)),
            Number(k.blocked) > 0 ? hx('em', { key: 'b', className: 'warn' }, '拦截 ' + k.blocked) : null,
          ])
        ))
      : hx('p', { key: 'none', className: 'sm-panel-muted' }, '今天还没有调用记录。'),

    hx('div', { key: 'form', className: 'sm-usage-form' }, [
      hx('h4', { key: 'h4', className: 'sm-panel-h3' }, '限额设置'),
      field(
        '每日自动额度',
        '填 0 表示不限额。只限制主动搭话等自动调用；你自己聊不受限。',
        hx('input', {
          key: 'cap',
          type: 'number',
          min: '0',
          step: '10000',
          value: String(d.dailyAutoTokenCap ?? 0),
          onChange: (e) => onDraft({ dailyAutoTokenCap: Number(e.target.value) }),
        })
      ),
      field(
        '超额时',
        '拦截会直接停下；只警告仍会调用，但记一条超额。',
        hx('select', { key: 'mode', value: d.onCapReached || 'block', onChange: (e) => onDraft({ onCapReached: e.target.value }) }, [
          hx('option', { key: 'b', value: 'block' }, '拦截（推荐）'),
          hx('option', { key: 'w', value: 'warn' }, '只警告，不拦截'),
        ])
      ),
      hx('div', { key: 'acts', className: 'sm-sprite-ops' }, [
        hx('button', { key: 'save', type: 'button', disabled: busy ? 'true' : undefined, onClick: onSave }, busy ? '保存中…' : '保存'),
        note ? hx('span', { key: 'note', className: 'sm-panel-muted' }, note) : null,
      ]),
    ]),
  ])
}

module.exports = { usageCard, fmt, sparkline, KIND_LABEL, K }
