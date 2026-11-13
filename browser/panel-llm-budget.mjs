// Optional dream / distill budget controls for the 作息与主动 tab.

function fmtTok(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0))
  return v.toLocaleString('en-US')
}

function llmBudgetBlock(p) {
  const enabled = !!p.enabled
  const cap = Math.max(0, Number(p.cap) || 0)
  const rem = p.budget && Number.isFinite(Number(p.budget.remaining))
    ? Math.max(0, Number(p.budget.remaining))
    : cap
  const used = p.budget && Number.isFinite(Number(p.budget.used))
    ? Number(p.budget.used)
    : Math.max(0, cap - rem)
  const pct = cap > 0 ? Math.min(100, Math.round((rem / cap) * 100)) : 0
  const models = Array.isArray(p.models) ? p.models : []
  const modelVal = p.model || ''
  return p.h('div', { key: p.key, className: 'sm-llm-budget' }, [
    p.h('label', { key: 'on', className: 'sm-llm-budget-on' }, [
      p.h('input', {
        key: 'i', type: 'checkbox', checked: enabled,
        onChange: (e) => p.onToggle(!!e.target.checked),
      }),
      p.h('span', { key: 't' }, p.title),
    ]),
    p.h('p', { key: 'warn', className: 'sm-llm-budget-warn' }, '开启会多花一点用量（默认用较便宜的模型）'),
    p.h('label', { key: 'model', className: 'sm-llm-budget-row' }, [
      p.h('span', { key: 'l' }, '模型'),
      p.h('select', {
        key: 's',
        value: modelVal,
        onChange: (e) => p.onModel(e.target.value),
      }, [
        p.h('option', { key: 'auto', value: '' }, models.length
          ? ('自动（' + ((p.budget && p.budget.modelLabel) || (p.budget && p.budget.model) || '最便宜') + '）')
          : '自动（最便宜）'),
        ...models.map((m) => p.h('option', { key: m.id, value: m.id }, m.label || m.id)),
      ]),
    ]),
    p.h('label', { key: 'cap', className: 'sm-llm-budget-row' }, [
      p.h('span', { key: 'l' }, '每日上限'),
      p.h('input', {
        key: 'n',
        type: 'number',
        min: 0,
        step: 1000,
        disabled: enabled,
        value: String(cap),
        onChange: (e) => p.onCap(Math.max(0, Number(e.target.value) || 0)),
      }),
    ]),
    p.h('div', { key: 'rem', className: 'sm-llm-budget-rem' }, [
      p.h('span', { key: 't' }, '今日剩余 ' + fmtTok(rem) + ' / ' + fmtTok(cap)
        + (used > 0 ? '（已用 ' + fmtTok(used) + '）' : '')),
      p.h('div', { key: 'track', className: 'sm-llm-budget-track' }, [
        p.h('i', { key: 'i', style: { width: pct + '%' } }),
      ]),
    ]),
  ])
}

function llmBudgetSection({ h, proDraft, usage, patchProactive }) {
  const models = (usage && usage.llmBudgets && usage.llmBudgets.models) || []
  return [
    llmBudgetBlock({
      key: 'dream-llm',
      title: '用 AI 润色夜里整理',
      enabled: !!(proDraft && proDraft.dreamLlmEnabled),
      cap: proDraft && proDraft.dreamLlmDailyCap,
      model: (proDraft && proDraft.dreamLlmModel) || '',
      budget: usage && usage.llmBudgets && usage.llmBudgets.dream,
      models,
      h,
      onToggle: (on) => patchProactive({ dreamLlmEnabled: on }),
      onCap: (n) => patchProactive({ dreamLlmDailyCap: n }),
      onModel: (id) => patchProactive({ dreamLlmModel: id }),
    }),
    llmBudgetBlock({
      key: 'distill-llm',
      title: '用 AI 润色周记整理',
      enabled: !!(proDraft && proDraft.distillLlmEnabled),
      cap: proDraft && proDraft.distillLlmDailyCap,
      model: (proDraft && proDraft.distillLlmModel) || '',
      budget: usage && usage.llmBudgets && usage.llmBudgets.distill,
      models,
      h,
      onToggle: (on) => patchProactive({ distillLlmEnabled: on }),
      onCap: (n) => patchProactive({ distillLlmDailyCap: n }),
      onModel: (id) => patchProactive({ distillLlmModel: id }),
    }),
  ]
}

module.exports = { llmBudgetBlock, llmBudgetSection, fmtTok }
