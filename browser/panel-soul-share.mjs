const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')
const { engHead } = require('./panel-cards.mjs')

const TRAIT_NAMES = { tsundere: '傲娇', clinginess: '粘人', sassiness: '毒舌', curiosity: '好奇', brevity: '简洁' }

function downloadMarkdown(fileName, markdown) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function SoulShareCard({ onImported }) {
  const [includeWiki, setIncludeWiki] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [dropped, setDropped] = React.useState([])
  const [importText, setImportText] = React.useState('')
  const [preview, setPreview] = React.useState(null)
  const [undoFile, setUndoFile] = React.useState('')
  const fileRef = React.useRef(null)

  async function doExport() {
    if (busy) return
    setBusy(true); setMsg('导出中…'); setDropped([])
    const res = await api('soul-share/export?wiki=' + (includeWiki ? '1' : '0'))
    setBusy(false)
    if (res && res.ok) {
      downloadMarkdown(res.fileName, res.markdown)
      setDropped(res.dropped || [])
      setMsg('已导出 ' + res.fileName + '，发给朋友吧。')
    } else setMsg((res && res.error) || '导出失败')
  }

  async function doPreview(text) {
    const markdown = typeof text === 'string' ? text : importText
    if (!markdown.trim()) { setMsg('先选文件或粘贴档案内容'); return }
    setBusy(true); setMsg('解析中…'); setPreview(null)
    const res = await api('soul-share/preview', { markdown })
    setBusy(false)
    if (res && res.ok) { setPreview(res.preview); setMsg('') }
    else setMsg((res && res.error) || '档案解析失败')
  }

  async function doImport() {
    if (busy || !preview) return
    setBusy(true); setMsg('导入中…')
    const res = await api('soul-share/import', { markdown: importText })
    setBusy(false)
    if (res && res.ok) {
      setUndoFile(res.snapshotFile || '')
      setPreview(null); setImportText('')
      setMsg('已导入「' + (preview.name || '') + '」的灵魂档案。')
      if (typeof onImported === 'function') onImported()
    } else setMsg((res && res.error) || '导入失败')
  }

  async function doUndo() {
    if (busy || !undoFile) return
    setBusy(true); setMsg('恢复中…')
    const res = await api('soul-share/undo', { snapshotFile: undoFile })
    setBusy(false)
    if (res && res.ok) {
      setUndoFile(''); setMsg('已恢复到导入前的人设。')
      if (typeof onImported === 'function') onImported()
    } else setMsg((res && res.error) || '恢复失败')
  }

  function onFile(ev) {
    const file = ev.target.files && ev.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setImportText(text)
      void doPreview(text)
    }
    reader.readAsText(file, 'utf-8')
  }

  const previewEl = preview ? h('div', { key: 'pv', className: 'sm-eng-clauses' }, [
    h('div', { key: 'who', className: 'sm-eng-clause' },
      h('span', null, preview.name + ' · ' + (preview.gender === 'male' ? '男' : '女') + ' · ' + preview.preset
        + ' · 自称「' + preview.selfRef + '」称呼你「' + preview.callUser + '」')),
    h('div', { key: 'tr', className: 'sm-eng-clause' },
      h('span', null, preview.traitScheme === 'mbti' && preview.mbti
        ? preview.mbti.type + ' · ' + Object.keys(TRAIT_NAMES).map((k) => TRAIT_NAMES[k] + ' ' + (preview.traits[k] ?? '?')).join(' ／ ')
        : Object.keys(TRAIT_NAMES).map((k) => TRAIT_NAMES[k] + ' ' + (preview.traits[k] ?? '?')).join(' ／ '))),
    preview.catchphrases.length ? h('div', { key: 'cp', className: 'sm-eng-clause' },
      h('span', null, '口癖：' + preview.catchphrases.slice(0, 3).join(' ／ '))) : null,
    preview.wikiImpressions.length ? h('div', { key: 'wi', className: 'sm-eng-clause' },
      h('span', null, '初见印象 ' + preview.wikiImpressions.length + ' 条（只作背景参考，不进你的记忆库）')) : null,
    h('p', { key: 'warn', className: 'sm-panel-muted', style: { color: '#c0392b' } },
      '导入将覆盖当前人设（自动快照，可撤销）；亲密度、本地记忆与不变量不受影响。'),
    h('button', { key: 'go', type: 'button', className: 'sm-panel-btn primary', disabled: busy, onClick: doImport }, '确认导入'),
  ]) : null

  return h('div', { key: 'soul-share', className: 'sm-eng-card' }, [
    engHead('07', '灵魂档案', '导出分享 · 导入别人的灵魂体', ''),
    h('p', { key: 'intro', className: 'sm-panel-muted' },
      '把你养出来的性格装进一个 .soulmate.md 文件：GitHub / 群里直接可读，朋友导入后就是同一个灵魂。私密记忆与亲密度永远不会被导出。'),
    h('label', { key: 'wiki', className: 'sm-rhythm-check sm-panel-muted', style: { marginTop: '8px' } }, [
      h('input', { key: 'cb', type: 'checkbox', checked: includeWiki, onChange: (ev) => setIncludeWiki(ev.target.checked) }),
      '附上公开记忆摘要（Wiki 标题与一句话，最多 20 条）',
    ]),
    h('div', { key: 'exp-ops', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } }, [
      h('button', { key: 'exp', type: 'button', className: 'sm-panel-btn', disabled: busy, onClick: doExport }, '导出 .soulmate.md'),
      h('button', { key: 'pick', type: 'button', className: 'sm-panel-btn', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, '导入灵魂档案'),
      h('input', { key: 'file', ref: fileRef, type: 'file', accept: '.md,.markdown,text/markdown', style: { display: 'none' }, onChange: onFile }),
      undoFile ? h('button', { key: 'undo', type: 'button', className: 'sm-panel-btn', disabled: busy, onClick: doUndo }, '撤销导入') : null,
    ]),
    dropped.length ? h('p', { key: 'drop', className: 'sm-panel-muted', style: { color: '#b8860b' } },
      '有 ' + dropped.length + ' 个字段因含敏感信息未导出：' + dropped.map((d) => d.field).join('、')) : null,
    h('textarea', {
      key: 'paste', className: 'sm-panel-textarea', rows: 3,
      placeholder: '或把 .soulmate.md 的内容粘贴到这里…',
      value: importText,
      onChange: (ev) => setImportText(ev.target.value),
      style: { minHeight: '72px', marginTop: '8px' },
    }),
    importText.trim() && !preview ? h('button', { key: 'pv', type: 'button', className: 'sm-panel-btn', disabled: busy, onClick: () => doPreview(), style: { marginTop: '8px' } }, '解析预览') : null,
    previewEl,
    msg ? h('p', { key: 'msg', className: 'sm-eng-note' }, msg) : null,
  ])
}

module.exports = { SoulShareCard }