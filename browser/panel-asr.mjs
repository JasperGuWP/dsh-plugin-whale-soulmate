// ASR 模型 ID 选择器:点「获取模型列表」从 ASR 服务拉模型 ID(OpenAI 兼容 /models),
// 下拉选中即填入;也保留手动输入(服务商不提供列表时)。
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

function field(key, label, control) {
  return h('label', { key, className: 'sm-panel-field' }, [
    h('span', { key: 'label' }, label),
    control,
  ])
}

function AsrModelPicker({ endpoint, apiKey, value, onCommit }) {
  const [models, setModels] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')
  const [filter, setFilter] = React.useState('')
  function load() {
    const ep = String(endpoint || '').trim()
    if (!ep) { setErr('先填 ASR 接口地址'); return }
    setBusy(true)
    setErr('')
    api('asr-models', { endpoint: ep, apiKey: String(apiKey || '') }).then((r) => {
      setBusy(false)
      if (r && r.ok && Array.isArray(r.models) && r.models.length) { setModels(r.models); return }
      setModels(null)
      setErr((r && (r.error || r.modelsUrl)) ? '获取失败:' + (r.error || '空列表') : '获取失败')
    }).catch(() => { setBusy(false); setErr('请求失败') })
  }
  return h('div', { className: 'sm-asr-model' }, [
    h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
      h('input', {
        key: 'i', type: 'text', className: 'sm-input', style: { flex: 1 },
        placeholder: '例如 whisper-1 / sensevoice-small;不要求可留空',
        value: value || '',
        onChange: (event) => { if (onCommit) onCommit(event.target.value) },
      }),
      h('button', {
        key: 'b', type: 'button', className: 'sm-panel-btn', disabled: busy,
        onClick: load,
      }, busy ? '获取中…' : '获取模型列表'),
    ]),
    models && models.length ? h('div', { key: 'list', style: { marginTop: 6 } }, [
      h('input', {
        key: 'filter', type: 'text', className: 'sm-input', style: { width: '100%', marginBottom: 4 },
        placeholder: '搜索模型(' + models.length + ' 个)…',
        value: filter,
        onChange: (event) => setFilter(event.target.value),
      }),
      h('select', {
        key: 'sel', className: 'sm-panel-input', style: { width: '100%' },
        value: value && models.includes(value) ? value : '',
        onChange: (event) => { if (event.target.value && onCommit) onCommit(event.target.value) },
      }, (() => {
        const shown = filter.trim() ? models.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())) : models
        return [
          h('option', { key: 'none', value: '' }, '从列表选择(' + shown.length + ' 个)'),
          ...shown.map((m) => h('option', { key: m, value: m }, m)),
        ]
      })()),
    ]) : null,
    err ? h('p', { key: 'err', className: 'sm-panel-muted', style: { marginTop: 4 } }, err) : null,
  ])
}

/** 无字幕视频的外部 ASR 设置；与画面理解总结互不依赖。 */
function AsrSettings({ ext, patchExtensions }) {
  const enabled = ext.biliAsrEnabled !== false
  const protocolValue = (() => {
    const p = String(ext.biliAsrProtocol || '').trim().toLowerCase()
    if (p === 'deepseek' || p === 'dashscope' || p === 'openai' || p === 'json') return p
    return /aliyuncs\.com|dashscope/i.test(String(ext.biliAsrEndpoint || '')) ? 'dashscope' : 'deepseek'
  })()
  return h('div', { key: 'asr-settings' }, [
    h('label', {
      key: 'asr-enabled',
      className: 'sm-rhythm-check',
      title: '官方没有字幕时,用外部 ASR 接口把音频转成文字(需要先填接口地址);与「画面理解总结」互不影响。',
    }, [
      h('input', {
        key: 'i', type: 'checkbox',
        checked: enabled,
        onChange: (event) => patchExtensions({ biliAsrEnabled: event.target.checked }),
      }),
      h('span', { key: 't' }, '无字幕 ASR 转写（外部接口）'),
    ]),
    enabled ? h('fieldset', {
      key: 'asr-group',
      style: { margin: '12px 0 0', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2,#e3e5e8)', background: 'var(--dsw-alias-bg-layer-1,#fafbfc)' },
    }, [
      h('legend', {
        key: 'asr-title',
        style: { padding: '0 6px', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary,#4e5561)' },
      }, 'ASR 转写配置'),
      field(
        'asr-protocol',
        'ASR 协议',
        h('select', {
          key: 'control', className: 'sm-panel-input',
          value: protocolValue,
          onChange: (event) => patchExtensions({ biliAsrProtocol: event.target.value }),
        }, [
          h('option', { key: 'deepseek', value: 'deepseek' }, 'DeepSeek ASR'),
          h('option', { key: 'dashscope', value: 'dashscope' }, 'Qwen ASR'),
          h('option', { key: 'openai', value: 'openai' }, '其他 ASR'),
          h('option', { key: 'json', value: 'json' }, '自定义 JSON'),
        ]),
      ),
      field(
        'asr-endpoint',
        'ASR 接口地址（无字幕时才用；留空则跳过）'
          + (String(ext.biliAsrEndpoint || '').trim() ? ' · 已配置' : ' · 未配置'),
        h('input', {
          key: 'control',
          type: 'url',
          placeholder: 'https://your-asr.example/v1/transcribe',
          value: ext.biliAsrEndpoint || '',
          onChange: (event) => patchExtensions({ biliAsrEndpoint: event.target.value }),
        }),
      ),
      field(
        'asr-key',
        'ASR API Key（可选，请求头 Bearer）',
        h('input', {
          key: 'control',
          type: 'password',
          autoComplete: 'off',
          placeholder: '填服务商发给你的 Key；不需要可留空',
          value: ext.biliAsrApiKey || '',
          onChange: (event) => patchExtensions({ biliAsrApiKey: event.target.value }),
        }),
      ),
      field(
        'asr-model',
        'ASR 模型 ID（可选，服务商要求时填；也可从列表拉取）',
        h(AsrModelPicker, {
          endpoint: ext.biliAsrEndpoint,
          apiKey: ext.biliAsrApiKey,
          value: ext.biliAsrModel,
          onCommit: (m) => patchExtensions({ biliAsrModel: m }),
        }),
      ),
    ]) : null,
  ])
}

module.exports = { AsrModelPicker, AsrSettings }
