// 「冲浪」标签：已接通平台（当前：B 站）+ 本平台冲浪日志。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')
const { autoSurfSection } = require('./panel-forms.mjs')
const { biliAuthCard } = require('./panel-bili.mjs')
const { SurfLightbox, StillThumb, stillUrl } = require('./surf-lightbox.mjs')

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
        null,
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

function openSurfDetail(entry, onOpen) {
  if (typeof onOpen === 'function') onOpen({ kind: 'detail', entry })
}

function surfLogCard(entry, onOpen, onDelete) {
  const url = String(entry.url || '').trim()
  const cover = String(entry.coverUrl || stillUrl(entry.stills && entry.stills[0]) || '').trim()
  const allStills = Array.isArray(entry.stills) ? entry.stills.filter(Boolean) : []
  const preview = allStills.slice(0, 3)
  const summary = entry.summary || '（无总结）'
  return h('article', { key: entry.id || entry.at + entry.videoId, className: 'sm-surf-log-card' }, [
    h('div', { key: 'media', className: 'sm-surf-log-media' }, [
      cover
        ? h('button', {
          key: 'cover',
          type: 'button',
          className: 'sm-surf-cover-btn',
          title: '点击看大图',
          onDoubleClick: (event) => {
            event.preventDefault()
            if (typeof onOpen === 'function') onOpen({ kind: 'image', url: cover })
          },
          onClick: (event) => {
            event.preventDefault()
            if (typeof onOpen === 'function') onOpen({ kind: 'image', url: cover })
          },
        }, h('img', { src: cover, alt: '', loading: 'lazy', className: 'sm-surf-log-cover' }))
        : h('div', { key: 'ph', className: 'sm-surf-log-cover sm-surf-log-cover-empty' }, '无封面'),
      preview.length
        ? h('div', { key: 'stills', className: 'sm-surf-log-stills' }, preview.map((still, i) => h(StillThumb, {
          key: 's' + i, still, onOpen,
        })))
        : null,
      allStills.length
        ? h('button', {
          key: 'all',
          type: 'button',
          className: 'sm-btn sm-surf-stills-all',
          onClick: () => {
            if (typeof onOpen === 'function') {
              onOpen({
                kind: 'gallery',
                title: (entry.title || entry.videoId || '视频') + ' · 分镜',
                items: allStills,
              })
            }
          },
        }, '查看全部分镜（' + allStills.length + '）')
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
      h('p', {
        key: 'sum',
        className: 'sm-surf-log-summary',
        title: '双击查看详情',
        onDoubleClick: (event) => {
          event.preventDefault()
          openSurfDetail(entry, onOpen)
        },
      }, summary),
      h('div', { key: 'sum-actions', className: 'sm-surf-log-summary-actions' }, [
        h('button', {
          key: 'detail',
          type: 'button',
          className: 'sm-btn sm-surf-detail-btn',
          onClick: () => openSurfDetail(entry, onOpen),
        }, '查看详情'),
        h('button', {
          key: 'del',
          type: 'button',
          className: 'sm-btn sm-surf-delete-btn',
          title: '从日志里删掉这一条',
          onClick: () => {
            if (typeof onDelete === 'function') onDelete(entry)
          },
        }, '删除'),
      ]),
      h('p', { key: 'act', className: 'sm-surf-log-actions' }, actionLine(entry.actions)),
      Array.isArray(entry.replies) && entry.replies.length
        ? h('ul', { key: 'rep', className: 'sm-surf-log-replies' }, entry.replies.map((r, i) => h('li', {
          key: 'r' + i,
        }, '跟帖' + (r.round != null ? ' #' + r.round : '') + '：' + String(r.text || '').slice(0, 80))))
        : null,
    ]),
  ])
}

const SURF_LOG_PAGE = 30

/** Local calendar day key YYYY-MM-DD from ISO/at string. */
function surfDayKey(at) {
  const d = new Date(at || Date.now())
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

function surfDayLabel(dayKey) {
  if (!dayKey) return '未知日期'
  const today = surfDayKey(Date.now())
  const yday = surfDayKey(Date.now() - 86400000)
  if (dayKey === today) return '今天'
  if (dayKey === yday) return '昨天'
  const parts = dayKey.split('-').map(Number)
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return parts[1] + '月' + parts[2] + '日'
  }
  return dayKey
}

function surfDaySub(dayKey) {
  if (!dayKey) return ''
  const today = surfDayKey(Date.now())
  const yday = surfDayKey(Date.now() - 86400000)
  if (dayKey === today || dayKey === yday) return dayKey
  return ''
}

function surfCard(view) {
  const { draft, patchExtensions } = view
  const [platform, setPlatform] = React.useState('bilibili')
  const [filter, setFilter] = React.useState('all')
  const [selectedDay, setSelectedDay] = React.useState('')
  const [dates, setDates] = React.useState({ items: [], loading: false, error: '' })
  const [log, setLog] = React.useState({
    entries: [], loading: false, loadingMore: false, hasMore: false, total: 0, error: '',
  })
  const [lightbox, setLightbox] = React.useState(null)
  const [openBili, setOpenBili] = React.useState(false)
  const [surfing, setSurfing] = React.useState(false)
  const [surfHint, setSurfHint] = React.useState('')
  const closeLightbox = React.useCallback(() => setLightbox(null), [])

  const deriveDatesFromEntries = React.useCallback((entries) => {
    const counts = new Map()
    for (const e of Array.isArray(entries) ? entries : []) {
      const day = surfDayKey(e && e.at)
      if (!day) continue
      counts.set(day, (counts.get(day) || 0) + 1)
    }
    return [...counts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  }, [])

  const fetchDates = React.useCallback(() => {
    setDates((prev) => ({ ...prev, loading: true, error: '' }))
    return api('surf-log?platform=bilibili&dates=1&filter=' + encodeURIComponent(filter))
      .then(async (res) => {
        let items = (res && Array.isArray(res.dates)) ? res.dates : []
        // Old node half (未重启) ignores dates=1 and only returns entries — derive locally.
        if (!items.length) {
          const fallback = await api(
            'surf-log?platform=bilibili&filter=' + encodeURIComponent(filter) + '&limit=200',
          )
          const entries = (fallback && Array.isArray(fallback.entries)) ? fallback.entries : []
          items = deriveDatesFromEntries(entries)
          if (fallback && fallback.ok === false && !items.length) {
            setDates({ items: [], loading: false, error: fallback.error || '' })
            return []
          }
        }
        setDates({
          items,
          loading: false,
          error: res && res.ok === false && !items.length ? res.error : '',
        })
        return items
      })
      .catch((err) => {
        setDates({ items: [], loading: false, error: err && err.message ? err.message : String(err) })
        return []
      })
  }, [filter, deriveDatesFromEntries])

  const fetchLogPage = React.useCallback((day, offset, { append } = {}) => {
    if (!day) {
      setLog({ entries: [], loading: false, loadingMore: false, hasMore: false, total: 0, error: '' })
      return Promise.resolve()
    }
    const q = 'surf-log?platform=bilibili'
      + '&filter=' + encodeURIComponent(filter)
      + '&day=' + encodeURIComponent(day)
      + '&limit=' + SURF_LOG_PAGE
      + '&offset=' + Math.max(0, offset | 0)
    setLog((prev) => ({
      ...prev,
      loading: !append,
      loadingMore: !!append,
      error: append ? prev.error : '',
    }))
    return api(q)
      .then((res) => {
        let next = (res && Array.isArray(res.entries)) ? res.entries : []
        // Old API may ignore day= — keep only the selected calendar day client-side.
        if (day) next = next.filter((e) => surfDayKey(e && e.at) === day)
        setLog((prev) => {
          const merged = append
            ? prev.entries.concat(next.filter((e) => !prev.entries.some((x) => x.id === e.id)))
            : next
          const total = (res && res.day === day && Number.isFinite(Number(res.total)))
            ? Number(res.total)
            : merged.length
          return {
            entries: merged,
            loading: false,
            loadingMore: false,
            hasMore: !!(res && res.hasMore) && (res.day === day || res.day == null),
            total,
            error: res && res.ok === false ? res.error : '',
          }
        })
      })
      .catch((err) => {
        setLog((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: err && err.message ? err.message : String(err),
          ...(append ? {} : { entries: [], hasMore: false, total: 0 }),
        }))
      })
  }, [filter])

  const reloadLog = React.useCallback(async () => {
    const items = await fetchDates()
    let day = selectedDay
    if (!day || !items.some((d) => d.day === day)) {
      day = items[0] ? items[0].day : ''
      setSelectedDay(day)
    }
    await fetchLogPage(day, 0, { append: false })
  }, [fetchDates, fetchLogPage, selectedDay])

  React.useEffect(() => {
    let cancelled = false
    fetchDates().then((items) => {
      if (cancelled) return
      const day = items[0] ? items[0].day : ''
      setSelectedDay(day)
      return fetchLogPage(day, 0, { append: false })
    })
    return () => { cancelled = true }
  }, [platform, filter, fetchDates, fetchLogPage])

  const selectDay = React.useCallback((day) => {
    if (!day || day === selectedDay) return
    setSelectedDay(day)
    fetchLogPage(day, 0, { append: false })
  }, [selectedDay, fetchLogPage])

  const loadMoreLog = React.useCallback(() => {
    if (!selectedDay || log.loadingMore || log.loading || !log.hasMore) return
    fetchLogPage(selectedDay, log.entries.length, { append: true })
  }, [fetchLogPage, selectedDay, log.loadingMore, log.loading, log.hasMore, log.entries.length])

  const deleteLogEntry = React.useCallback(async (entry) => {
    if (!entry) return
    const title = String(entry.title || entry.videoId || '这条记录').slice(0, 40)
    if (typeof window !== 'undefined' && window.confirm) {
      if (!window.confirm('删除冲浪记录「' + title + '」？此操作不可撤销。')) return
    }
    const res = await api('surf-log', {
      action: 'delete',
      platform: 'bilibili',
      id: entry.id || '',
      videoId: entry.videoId || entry.bvid || '',
      at: entry.at || '',
    })
    if (!res || res.ok === false) {
      setSurfHint((res && res.error) || '删除失败')
      return
    }
    setLightbox(null)
    setSurfHint('已删除 1 条记录')
    await reloadLog()
  }, [reloadLog])

  const runSurfNow = React.useCallback(async () => {
    if (surfing) return
    setSurfing(true)
    setSurfHint('正在巡片并互动…')
    try {
      const res = await api('video-watch', { action: 'surf' })
      if (!res || res.ok === false) {
        setSurfHint((res && res.error) || '冲浪失败')
        return
      }
      const n = Number(res.pickedCount || 0)
      const skippedTitle = Number(res.skippedTitleCount || 0)
      const visionBits = (Array.isArray(res.videos) ? res.videos : [])
        .filter((v) => v && v.ok)
        .map((v) => (v.channels && v.channels.visionSummary) || (v.coverage && v.coverage.visionSummary) || '')
        .filter(Boolean)
      const visionNote = visionBits.some((c) => String(c).startsWith('ok:'))
        ? '含时间线总结'
        : visionBits.length
          ? ('画面总结：' + visionBits[0])
          : ''
      setSurfHint(
        (n > 0 ? `本轮看了 ${n} 条` : '本轮没有值得看的新片')
          + (skippedTitle > 0 ? `，跳过 ${skippedTitle} 条引流标题` : '')
          + (visionNote ? `（${visionNote}）` : '')
          + '，日志已刷新',
      )
      await reloadLog()
    } catch (err) {
      setSurfHint(err && err.message ? err.message : String(err))
    } finally {
      setSurfing(false)
    }
  }, [surfing, reloadLog])

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
    h('header', { key: 'h', className: 'sm-eng-head sm-surf-log-head' }, [
      h('span', { key: 'n', className: 'sm-eng-num' }, '日志'),
      h('div', { key: 't', className: 'sm-surf-log-head-text' }, [
        h('h3', { key: 'title' }, 'B 站冲浪日志'),
        null,
      ]),
      h('button', {
        key: 'now',
        type: 'button',
        className: 'sm-btn primary sm-surf-now-btn',
        disabled: surfing,
        title: '立刻按兴趣词巡片、写总结，并按性格决定赞/藏/评/关注',
        onClick: runSurfNow,
      }, surfing ? '冲浪中…' : '立刻冲浪'),
    ]),
    surfHint ? h('p', { key: 'hint', className: 'sm-panel-muted sm-surf-now-hint' }, surfHint) : null,
    filterBar,
    h('div', { key: 'split', className: 'sm-surf-log-split' }, [
      h('aside', { key: 'dates', className: 'sm-surf-log-dates', 'aria-label': '日期' }, [
        h('div', { key: 'dh', className: 'sm-surf-log-dates-title' }, '日期'),
        dates.loading ? h('p', { key: 'ld', className: 'sm-panel-muted' }, '…') : null,
        dates.error ? h('p', { key: 'err', className: 'sm-panel-muted' }, dates.error) : null,
        !dates.loading && !dates.items.length
          ? h('p', { key: 'empty', className: 'sm-panel-muted' }, '暂无记录')
          : h('div', { key: 'list', className: 'sm-surf-log-dates-list', role: 'tablist' },
            dates.items.map((item) => h('button', {
              key: item.day,
              type: 'button',
              role: 'tab',
              'aria-selected': selectedDay === item.day ? 'true' : 'false',
              className: 'sm-surf-log-date' + (selectedDay === item.day ? ' on' : ''),
              onClick: () => selectDay(item.day),
            }, [
              h('span', { key: 'l', className: 'sm-surf-log-date-label' }, surfDayLabel(item.day)),
              surfDaySub(item.day)
                ? h('span', { key: 's', className: 'sm-surf-log-date-sub' }, surfDaySub(item.day))
                : h('span', { key: 's', className: 'sm-surf-log-date-sub' }, item.day),
              h('span', { key: 'n', className: 'sm-surf-log-date-count' }, item.count + ' 条'),
            ]))),
      ]),
      h('div', { key: 'main', className: 'sm-surf-log-main' }, [
        selectedDay
          ? h('header', { key: 'mh', className: 'sm-surf-log-main-head' }, [
            h('h4', { key: 't' }, surfDayLabel(selectedDay) + (surfDaySub(selectedDay) ? '' : '') + ' · ' + selectedDay),
            h('span', { key: 'n', className: 'sm-panel-muted' },
              (log.total || log.entries.length) + ' 条'
                + (log.hasMore ? '（已显示 ' + log.entries.length + '）' : '')),
          ])
          : null,
        log.loading ? h('p', { key: 'ld', className: 'sm-panel-muted' }, '读取中…') : null,
        log.error ? h('p', { key: 'err', className: 'sm-panel-muted' }, log.error) : null,
        !log.loading && !log.entries.length
          ? h('p', { key: 'empty', className: 'sm-panel-muted' },
            dates.items.length
              ? '这一天还没有记录。'
              : '还没有冲浪记录。点右上角「立刻冲浪」，或打开上方定时刷。')
          : h('div', { key: 'list-wrap', className: 'sm-surf-log-scroll' }, [
            h('div', { key: 'list', className: 'sm-surf-log-list' },
              log.entries.map((entry) => surfLogCard(entry, setLightbox, deleteLogEntry))),
            log.hasMore
              ? h('button', {
                key: 'more',
                type: 'button',
                className: 'sm-btn sm-surf-log-more',
                disabled: log.loadingMore,
                onClick: loadMoreLog,
              }, log.loadingMore ? '加载中…' : '加载更多')
              : null,
          ]),
      ]),
    ]),
  ])

  return h('div', { key: 'surf', className: 'sm-surf-page' }, [
    platformBar,
    !openBili
      ? h('div', { key: 'gate', className: 'sm-eng-card sm-surf-gate' }, [
        null,
        h('button', {
          key: 'go',
          type: 'button',
          className: 'sm-btn primary sm-surf-gate-btn',
          onClick: () => setOpenBili(true),
        }, 'B站登录冲浪'),
      ])
      : h('div', { key: 'bili-body', className: 'sm-surf-body' }, [
        h('div', { key: 'gate-bar', className: 'sm-surf-gate-bar' }, [
          h('button', {
            key: 'fold', type: 'button', className: 'sm-btn', onClick: () => setOpenBili(false),
          }, '收起 B 站'),
        ]),
        h(biliAuthCard, { key: 'auth' }),
        h('div', { key: 'autosurf', className: 'sm-eng-card' }, [
          h('header', { key: 'h', className: 'sm-eng-head' }, [
            h('span', { key: 'n', className: 'sm-eng-num' }, '定时'),
            h('div', { key: 't' }, [
              h('h3', { key: 'title' }, '定时冲浪'),
              null,
            ]),
          ]),
          ...autoSurfSection({ draft, patchExtensions }),
        ]),
        engageSection({ draft, patchExtensions }),
        logSection,
      ]),
    lightbox
      ? h(SurfLightbox, {
        key: 'lb',
        shot: lightbox,
        onClose: closeLightbox,
        onDelete: deleteLogEntry,
        actionLine,
      })
      : null,
  ])
}

module.exports = { surfCard, PLATFORMS, actionLine }
