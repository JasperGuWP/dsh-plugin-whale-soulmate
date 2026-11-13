// Read-only overview cards (状态 / 主动习惯 / 人设底色).
const React = require('react')
const h = React.createElement

function pct(raw, max) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, (n / max) * 100))
}

function engHead(idx, title, note, tone) {
  const toneLabel = tone === 'idle' ? '固定' : tone === 'warn' ? '推算' : '实时'
  return h('div', { key: 'h', className: 'sm-eng-head' }, [
    h('span', { key: 'idx', className: 'sm-eng-idx' }, idx),
    h('span', { key: 'title', className: 'sm-eng-title' }, title, note ? h('em', { key: 'note' }, note) : null),
    h('span', { key: 'state', className: 'sm-eng-state' }, [
      h('span', { key: 'dot', className: 'sm-eng-dot' + (tone ? ' ' + tone : '') }),
      toneLabel,
    ]),
  ])
}

function metric(key, label, value, unit, sub, meter, text, hint) {
  return h('div', { key, className: 'sm-metric', title: hint || undefined }, [
    h('span', { key: 'lb', className: 'lb' }, label),
    h('span', { key: 'val', className: 'val' + (text ? ' tiny' : '') }, String(value), unit ? h('span', { key: 'u', className: 'u' }, unit) : null),
    sub ? h('span', { key: 'sub', className: 'sub' }, sub) : null,
    meter != null ? h('span', { key: 'mtr', className: 'mtr' }, h('b', { style: { width: Math.max(2, meter) + '%' } })) : null,
  ])
}

const STATUS_HINTS = Object.freeze({
  warmth: '相处热乎程度，旁注是信任感。',
  energy: '精力：聊天会消耗，休息会恢复。',
  affinity: '亲密度：越高阶段称号越高；点桌宠也会增加。',
  memory: '她记住的事、词条和日记合计。',
  conflicts: '有互相打架的记忆时，需要你选留哪一条。',
  time: '距离上次联系过了多久。',
  pending: '她想微调性格、还在观察中的申请条数。',
  budget: '这次对话里，身份 / 关系 / 记忆各占多少比重。',
})

function statusCard(ctx) {
  const { rel, st, state, stage, mem, time, budget, pending } = ctx
  const facts = mem.activeFacts ?? mem.facts ?? 0
  return h('div', { key: 'status', className: 'sm-eng-card' }, [
    engHead('01', '此刻状态', '一眼看懂她现在怎样', ''),
    h('div', { key: 'grid', className: 'sm-eng-grid' }, [
      metric('w', '关系温度', rel.warmth ?? '—', null, '信任 ' + (rel.trust ?? '—'), pct(rel.warmth, 100), null, STATUS_HINTS.warmth),
      metric('e', '精力', st.energy ?? state.energy ?? '—', null, '0–100', pct(st.energy ?? state.energy, 100), null, STATUS_HINTS.energy),
      metric('a', '亲密度', st.affinity ?? state.affinity ?? '—', null, (stage.title || '初遇'), pct(st.affinity ?? state.affinity, 1000), null, STATUS_HINTS.affinity),
      metric('m', '记忆条数', facts + (mem.wiki || 0) + (mem.episodes || 0), null,
        '常用 ' + facts + ' · 词条 ' + (mem.wiki || 0) + ' · 日记 ' + (mem.episodes || 0), null, STATUS_HINTS.memory),
      metric('cf', '待你确认', String(mem.conflictsOpen ?? 0), null, mem.conflictsOpen ? '有冲突，见下方' : '没有冲突', null, null, STATUS_HINTS.conflicts),
      metric('t', '多久没聊', time.relativeHours != null ? time.relativeHours : '—', '小时', null, null, null, STATUS_HINTS.time),
      metric('c', '性格申请', String(pending), null, pending ? '观察中' : '暂无', null, null, STATUS_HINTS.pending),
    ]),
    h('div', { key: 'budget', className: 'sm-eng-foot', title: STATUS_HINTS.budget }, [
      h('div', { key: 'cap', className: 'cap' }, [
        h('span', null, '记忆占比'),
        h('b', { className: budget.withinBudget ? 'ok' : 'warn' }, budget.withinBudget ? '正常' : '偏高'),
      ]),
      h('div', { key: 'rows', className: 'sm-eng-budget' },
        [['身份', 'identity'], ['关系', 'relationship'], ['记忆', 'memory']].map(([lab, key]) => {
          const m = (budget.measured && budget.measured[key]) || {}
          const target = budget[key] || (m.budget || 0)
          const actual = Number(m.share) || 0
          return h('div', { key: lab, className: 'sm-eng-budget-row' }, [
            h('span', null, lab),
            h('i', null, h('b', { style: { width: Math.min(100, actual) + '%' } })),
            h('span', null, actual + '% / 目标 ' + target + '%'),
          ])
        })
      ),
      !budget.withinBudget && budget.note
        ? h('p', { key: 'note', className: 'sm-panel-muted' }, budget.note)
        : null,
    ]),
  ])
}

const toneWord = { sharp: '直接', gentle: '柔和', balanced: '适中' }
const lenWord = { short: '偏短', detailed: '偏长', medium: '适中' }
const gateModeWord = { enforced: '会主动找你', preview: '仅预览' }

const SCHED_HINTS = Object.freeze({
  initiative: '越高越爱先开口；改性格后会跟着变。',
  silence: '安静多久之后，才考虑主动搭话。',
  tone: '说话风格偏向。',
  length: '默认话量长短。',
  gate: '是否真的会主动开口。',
  ask: '主动前要不要先问你一声。',
  tool: '能不能用工具，由软件权限决定。',
  card: '根据性格推算的主动习惯。',
})

const TRUST_HINTS = Object.freeze({
  card: '承诺、冲突，以及她最近常挂在心上的事。',
  conflicts: '新旧记忆打架时，请你选留哪一条。',
  noConflicts: '目前没有互相打架的记忆。',
  promises: '她答应你的事，可在这里标记兑现或作废。',
  noPromises: '还没有未了的承诺。',
  presence: '她最近常记得的事，会影响怎么开口。',
})

function schedulingCard(strategy) {
  const mode = (strategy.openingGate && strategy.openingGate.mode) || 'preview'
  return h('div', { key: 'sched', className: 'sm-eng-card', title: SCHED_HINTS.card }, [
    engHead('02', '主动习惯', '由性格推算', 'warn'),
    h('div', { key: 'grid', className: 'sm-eng-grid' }, [
      metric('i', '主动性', strategy.initiative ?? '—', null, '0–100', pct(strategy.initiative, 100), null, SCHED_HINTS.initiative),
      metric('s', '安静多久才开口', strategy.silenceThresholdHours != null ? strategy.silenceThresholdHours : '—', '小时', null, null, null, SCHED_HINTS.silence),
      metric('tone', '语气', toneWord[strategy.toneBias] || strategy.toneBias || '—', null, null, null, true, SCHED_HINTS.tone),
      metric('len', '回复长短', lenWord[strategy.replyLengthBias] || strategy.replyLengthBias || '—', null, null, null, true, SCHED_HINTS.length),
    ]),
    h('div', { key: 'tags', className: 'sm-eng-tags' }, [
      h('span', { key: 'gate', className: 'sm-eng-tag', title: SCHED_HINTS.gate }, [h('i'), gateModeWord[mode] || '会主动找你']),
      h('span', { key: 'ask', className: 'sm-eng-tag', title: SCHED_HINTS.ask }, [h('i'), strategy.openingGate && strategy.openingGate.askFirst ? '主动前先问你' : '条件够可直接开口']),
      h('span', { key: 'tool', className: 'sm-eng-tag', title: SCHED_HINTS.tool }, [h('i'), '工具看软件权限']),
    ]),
  ])
}

function personaCard({ inv, changelog, selfText, hasSelf }) {
  const reasonMap = {
    user_customize: '你改过性格',
    'preset:geek-partner': '换成了极客搭档',
    'preset:gentle-echo': '换成了温柔回响',
    'preset:rice-whale': '换成了干饭鲸鱼',
    'preset:blank-custom': '换成了空白画布',
  }
  let recent = null
  if (changelog && changelog.length) {
    const raw = changelog[0].reason || changelog[0].source || ''
    recent = String(changelog[0].at || '').slice(5, 16).replace('T', ' ') + ' · ' + (reasonMap[raw] || '性格有更新')
  }
  return h('div', { key: 'persona-layer', className: 'sm-eng-card' }, [
    engHead('03', '人设底色', '不变的原则', 'idle'),
    h('div', { key: 'inv', className: 'sm-eng-clauses' }, [].concat(inv.values || [], inv.boundaries || []).slice(0, 6).map((text, i) =>
      h('span', { key: 'inv' + i, className: 'sm-eng-clause' }, text)
    )),
    hasSelf
      ? h('p', { key: 'self', className: 'sm-eng-quote' }, selfText)
      : h('p', { key: 'self', className: 'sm-eng-note' }, '还没有写自我描述。'),
    recent
      ? h('p', { key: 'log', className: 'sm-eng-note' }, '最近更新 · ' + recent)
      : h('p', { key: 'nolog', className: 'sm-eng-note' }, '还没有性格变更记录'),
  ])
}

module.exports = {
  pct, engHead, metric, statusCard, schedulingCard, personaCard,
  STATUS_HINTS, SCHED_HINTS, TRUST_HINTS,
}
