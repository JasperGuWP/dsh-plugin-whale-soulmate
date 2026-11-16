// 「冲浪」标签：已接通平台（当前：B 站）+ 本平台冲浪日志。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')
const { autoSurfSection } = require('./panel-forms.mjs')
const { biliAuthCard } = require('./panel-bili.mjs')

const PLATFORMS = [
  { id: 'bilibili', label: 'B站' },
]

function engageSection({ draft, patchExtensions }) {
  const ext = draft.extensions || {}
  const writeHint = '需先在上方开启「允许 B 站写操作」。'
  return h('div', { key: 'engage', className: 'sm-eng-card sm-surf-engage' }, [
    h('header', { key: 'h', className: 'sm-eng-head' }, [
      h('span', { key: 'n', className: 'sm-eng-num' }, '互动'),
      h('div', { key: 't' }, [
        h('h3', { key: 'title' }, '按性格自动互动'),
        h('p', { key: 's', className: 'sm-panel-muted' },
          '看完片子后自行决定赞 / 藏 / 评 / 关注；别人回评时可跟帖（同楼最多几轮）。'),
      ]),
    ]),
    h('label', { key: 'engage-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox',
        checked: ext.biliAutoEngageEnabled !== false,
        onChange: (e) => patchExtensions({ biliAutoEngageEnabled: e.target.checked }),
      }),
      h('span', { key: 't' }, '冲浪后自动决定赞 / 收藏 / 评论 / 关注'),
    ]),
    h('label', { key: 'reply-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox',
        checked: ext.biliAutoReplyEnabled !== false,
        onChange: (e) => patchExtensions({ biliAutoReplyEnabled: e.target.checked }),
      }),
      h('span', { key: 't' }, '别人回复时自动跟帖（同楼最多 '
        + (ext.biliAutoReplyMaxRounds || 3) + ' 轮）'),
    ]),
    h('p', { key: 'hint', className: 'sm-panel-muted' }, writeHint + '遵守平台评论规范与每日写配额。'),
  ])
}

function actionLine(actions) {
  if (!actions || typeof actions !== 'object') return '在平台做过什么：未知'
  const bits = []
  if (actions.like) bits.push('点赞')
  if (actions.favorite) bits.push('收藏')
  if (actions.follow) bits.push('关注')
  if (actions.comment) bits.push('评论' + (actions.commentText ? '「' + String(actions.commentText).slice(0, 40) + '」' : ''))
  if (!bits.length) {
    const why = Array.isArray(actions.skippedReasons) && actions.skippedReasons.length
      ? actions.skippedReasons.join('；')
      : (actions.reason || '未互动')
    return '在平台做过什么：未互动（' + why + '）'
  }
  return '在平台做过什么：' + bits.join(' · ')
}

function surfLogCard(entry) {
  const url = String(entry.url || '').trim()
  const cover = String(entry.coverUrl || (entry.stills && entry.stills[0]) || '').trim()
  const stills = Array.isArray(entry.stills) ? entry.stills.filter(Boolean).slice(0, 3) : []
  return h('article', { key: entry.id || entry.at + entry.videoId, className: 'sm-surf-log-card' }, [
    h('div', { key: 'media', className: 'sm-surf-log-media' }, [
      cover
        ? h('img', { key: 'cover', src: cover, alt: '', loading: 'lazy', className: 'sm-surf-log-cover' })
        : h('div', { key: 'ph', className: 'sm-surf-log-cover sm-surf-log-cover-empty' }, '无封面'),
      stills.length
        ? h('div', { key: 'stills', className: 'sm-surf-log-stills' }, stills.map((src, i) => h('img', {
          key: 's' + i, src, alt: '', loading: 'lazy',
        })))
        : null,
    ]),
    h('div', { key: 'body', className: 'sm-surf-log-body' }, [
      h('div', { key: 'title-row', className: 'sm-surf-log-title' }, [
        url
          ? h('a', { key: 'a', href: url, target: '_blank', rel: 'noreferrer' }, entry.title || entry.videoId || '视频')
          : h('span', { key: 't' }, entry.title || entry.videoId || '视频'),
      ]),
      h('p', { key: 'meta', className: 'sm-panel-muted' },
        [entry.author ? '@' + entry.author : '', entry.worthScore != null ? '评分 ' + entry.worthScore + '/20' : '', entry.at ? String(entry.at).slice(0, 19).replace('T', ' ') : '']
          .filter(Boolean).join(' · ')),
      h('p', { key: 'sum', className: 'sm-surf-log-summary' }, entry.summary || '（无总结）'),
      h('p', { key: 'act', className: 'sm-surf-log-actions' }, actionLine(entry.actions)),
      Array.isArray(entry.replies) && entry.replies.length
        ? h('ul', { key: 'rep', className: 'sm-surf-log-replies' }, entry.replies.map((r, i) => h('li', {
          key: 'r' + i,
        }, '跟帖' + (r.round != null ? ' #' + r.round : '') + '：' + String(r.text || '').slice(0, 80))))
        : null,
    ]),
  ])
}

function surfCard(view) {
  const { draft, patchExtensions } = view
  const [platform, setPlatform] = React.useState('bilibili')
  const [filter, setFilter] = React.useState('all')
  const [log, setLog] = React.useState({ entries: [], loading: false })

  React.useEffect(() => {
    let cancelled = false
    setLog((prev) => ({ ...prev, loading: true }))
    api('surf-log?platform=bilibili&filter=' + encodeURIComponent(filter) + '&limit=40')
      .then((res) => {
        if (cancelled) return
        setLog({
          entries: (res && Array.isArray(res.entries)) ? res.entries : [],
          loading: false,
          error: res && res.ok === false ? res.error : '',
        })
      })
      .catch((err) => {
        if (cancelled) return
        setLog({ entries: [], loading: false, error: err && err.message ? err.message : String(err) })
      })
    return () => { cancelled = true }
  }, [platform, filter])

  const platformBar = PLATFORMS.length > 1
    ? h('div', { key: 'plats', className: 'sm-surf-platforms', role: 'tablist' }, PLATFORMS.map((p) => h('button', {
      key: p.id,
      type: 'button',
      role: 'tab',
      'aria-selected': platform === p.id ? 'true' : 'false',
      className: 'sm-surf-platform' + (platform === p.id ? ' on' : ''),
      onClick: () => setPlatform(p.id),
    }, p.label)))
    : null

  const filterBar = h('div', { key: 'filt', className: 'sm-surf-filters' }, [
    ['all', '全部'],
    ['engaged', '有互动'],
    ['watch-only', '仅观看'],
  ].map(([id, label]) => h('button', {
    key: id,
    type: 'button',
    className: 'sm-btn' + (filter === id ? ' primary' : ''),
    onClick: () => setFilter(id),
  }, label)))

  const logSection = h('div', { key: 'log', className: 'sm-eng-card sm-surf-log' }, [
    h('header', { key: 'h', className: 'sm-eng-head' }, [
      h('span', { key: 'n', className: 'sm-eng-num' }, '日志'),
      h('div', { key: 't' }, [
        h('h3', { key: 'title' }, 'B 站冲浪日志'),
        h('p', { key: 's', className: 'sm-panel-muted' }, '截图、链接、总结，以及在 B 站做过什么。'),
      ]),
    ]),
    filterBar,
    log.loading ? h('p', { key: 'ld', className: 'sm-panel-muted' }, '读取中…') : null,
    log.error ? h('p', { key: 'err', className: 'sm-panel-muted' }, log.error) : null,
    !log.loading && !log.entries.length
      ? h('p', { key: 'empty', className: 'sm-panel-muted' }, '还没有冲浪记录。打开上方定时刷，或让他看片后会出现在这里。')
      : h('div', { key: 'list', className: 'sm-surf-log-list' }, log.entries.map(surfLogCard)),
  ])

  return h('div', { key: 'surf', className: 'sm-surf-page' }, [
    platformBar,
    h(biliAuthCard, { key: 'auth' }),
    h('div', { key: 'autosurf', className: 'sm-eng-card' }, [
      h('header', { key: 'h', className: 'sm-eng-head' }, [
        h('span', { key: 'n', className: 'sm-eng-num' }, '定时'),
        h('div', { key: 't' }, [
          h('h3', { key: 'title' }, '定时冲浪'),
          h('p', { key: 's', className: 'sm-panel-muted' }, '按兴趣关键词巡片；免打扰时段不巡。'),
        ]),
      ]),
      ...autoSurfSection({ draft, patchExtensions }),
    ]),
    engageSection({ draft, patchExtensions }),
    logSection,
  ])
}

module.exports = { surfCard, PLATFORMS, actionLine }
