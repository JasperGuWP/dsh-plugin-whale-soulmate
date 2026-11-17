// 冲浪灯箱：详情弹窗 / 全部分镜网格 / 单帧放大。

const React = require('react')
const h = React.createElement

function stillUrl(still) {
  if (!still) return ''
  if (typeof still === 'string') return still
  return String(still.url || still.imageUrl || '').trim()
}

function cssUrl(u) {
  return 'url("' + String(u || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")'
}

function openShotFromStill(still) {
  if (!still) return null
  if (typeof still === 'string') return { kind: 'image', url: still }
  const url = stillUrl(still)
  if (!url) return null
  if (!(still.width > 0 && still.sheetWidth > still.width)) {
    return { kind: 'image', url }
  }
  return {
    kind: 'crop',
    url,
    x: Number(still.x) || 0,
    y: Number(still.y) || 0,
    width: Number(still.width) || 160,
    height: Number(still.height) || 90,
    sheetWidth: Number(still.sheetWidth) || 160,
    sheetHeight: Number(still.sheetHeight) || 90,
    label: still.label || '',
  }
}

function StillThumb({ still, onOpen }) {
  const open = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const shot = openShotFromStill(still)
    if (shot && typeof onOpen === 'function') onOpen(shot)
  }
  if (typeof still === 'string') {
    return h('button', {
      type: 'button',
      className: 'sm-surf-still sm-surf-still-full',
      title: '双击看大图',
      onDoubleClick: open,
      onClick: open,
    }, h('img', { src: still, alt: '', loading: 'lazy' }))
  }
  return h('button', {
    type: 'button',
    className: 'sm-surf-still',
    title: (still.label ? still.label + ' · ' : '') + '双击看大图',
    style: {
      backgroundImage: cssUrl(stillUrl(still)),
      backgroundPosition: '-' + (Number(still.x) || 0) + 'px -' + (Number(still.y) || 0) + 'px',
      backgroundSize: (Number(still.sheetWidth) || 160) + 'px ' + (Number(still.sheetHeight) || 90) + 'px',
      backgroundRepeat: 'no-repeat',
    },
    onDoubleClick: open,
    onClick: open,
  })
}

function SurfLightbox({ shot, onClose, onDelete, actionLine }) {
  const [focus, setFocus] = React.useState(null)
  const focusRef = React.useRef(null)
  focusRef.current = focus

  // Only reset focus when the lightbox payload changes — never when focus itself updates
  // (old deps included `focus`, so click-to-zoom immediately cleared itself → flash).
  React.useEffect(() => {
    setFocus(null)
  }, [shot])

  React.useEffect(() => {
    if (!shot) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (focusRef.current) setFocus(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shot, onClose])

  if (!shot) return null
  const zoom = 3
  const active = focus || (shot.kind === 'gallery' ? null : shot)

  if (shot.kind === 'detail') {
    const entry = shot.entry || {}
    const url = String(entry.url || '').trim()
    const summary = String(entry.summary || '（无总结）')
    const missingTimeline = /未看画面|未接通|未生成时间线|画面理解失败/.test(summary)
      && !/时间线\s*[:：]/.test(summary)
    const allStills = Array.isArray(entry.stills) ? entry.stills.filter(Boolean) : []
    return h('div', {
      className: 'sm-surf-lightbox',
      role: 'dialog',
      'aria-modal': 'true',
      onClick: onClose,
    }, [
      h('div', {
        key: 'inner',
        className: 'sm-surf-lightbox-inner sm-surf-lightbox-detail',
        onClick: (event) => event.stopPropagation(),
      }, [
        h('header', { key: 'h', className: 'sm-surf-detail-head' }, [
          h('strong', { key: 't' }, entry.title || entry.videoId || '冲浪详情'),
          h('span', { key: 'm', className: 'sm-panel-muted' },
            [entry.author ? '@' + entry.author : '', entry.worthScore != null ? '评分 ' + entry.worthScore + '/20' : '', entry.at ? String(entry.at).slice(0, 19).replace('T', ' ') : '']
              .filter(Boolean).join(' · ')),
        ]),
        missingTimeline
          ? h('p', { key: 'warn', className: 'sm-surf-detail-warn' },
            '这条没有画面时间线（总结时没把截帧送给聊天多模态）。旧记录不会回填；请完全退出并重开 DSH 后再点「立刻冲浪」生成带「时间线：」的新条目。')
          : null,
        h('pre', { key: 'sum', className: 'sm-surf-detail-summary' }, summary),
        h('p', { key: 'act', className: 'sm-surf-log-actions' }, actionLine(entry.actions)),
        allStills.length
          ? h('div', { key: 'stills', className: 'sm-surf-detail-stills' }, allStills.map((still, i) => h(StillThumb, {
            key: 'd' + i, still, onOpen: (s) => setFocus(s),
          })))
          : null,
        focus
          ? h('div', { key: 'focus', className: 'sm-surf-gallery-focus' }, [
            focus.kind === 'crop'
              ? h('div', {
                key: 'crop',
                className: 'sm-surf-lightbox-crop',
                style: {
                  width: (focus.width || 160) * zoom,
                  height: (focus.height || 90) * zoom,
                  backgroundImage: cssUrl(focus.url),
                  backgroundPosition: '-' + ((focus.x || 0) * zoom) + 'px -' + ((focus.y || 0) * zoom) + 'px',
                  backgroundSize: ((focus.sheetWidth || 160) * zoom) + 'px ' + ((focus.sheetHeight || 90) * zoom) + 'px',
                  backgroundRepeat: 'no-repeat',
                },
              })
              : h('img', { key: 'img', src: focus.url, alt: focus.label || '预览' }),
            h('button', {
              key: 'back', type: 'button', className: 'sm-btn', onClick: () => setFocus(null),
            }, '返回详情'),
          ])
          : null,
        h('div', { key: 'foot', className: 'sm-surf-detail-foot' }, [
          url
            ? h('a', { key: 'a', className: 'sm-btn', href: url, target: '_blank', rel: 'noreferrer' }, '打开原视频')
            : null,
          h('button', {
            key: 'del',
            type: 'button',
            className: 'sm-btn sm-surf-delete-btn',
            onClick: () => {
              if (typeof onDelete === 'function') onDelete(entry)
            },
          }, '删除这条'),
          h('button', {
            key: 'close', type: 'button', className: 'sm-btn primary', onClick: onClose,
          }, '关闭'),
        ]),
      ]),
    ])
  }

  if (shot.kind === 'gallery') {
    const items = Array.isArray(shot.items) ? shot.items : []
    return h('div', {
      className: 'sm-surf-lightbox',
      role: 'dialog',
      'aria-modal': 'true',
      onClick: onClose,
    }, [
      h('div', {
        key: 'inner',
        className: 'sm-surf-lightbox-inner sm-surf-lightbox-gallery',
        onClick: (event) => event.stopPropagation(),
      }, [
        h('header', { key: 'h', className: 'sm-surf-gallery-head' }, [
          h('strong', { key: 't' }, shot.title || '全部分镜'),
          h('span', { key: 'n', className: 'sm-panel-muted' }, items.length + ' 帧 · 点击单帧放大'),
        ]),
        focus
          ? h('div', { key: 'focus', className: 'sm-surf-gallery-focus' }, [
            focus.kind === 'crop'
              ? h('div', {
                key: 'crop',
                className: 'sm-surf-lightbox-crop',
                style: {
                  width: (focus.width || 160) * zoom,
                  height: (focus.height || 90) * zoom,
                  backgroundImage: cssUrl(focus.url),
                  backgroundPosition: '-' + ((focus.x || 0) * zoom) + 'px -' + ((focus.y || 0) * zoom) + 'px',
                  backgroundSize: ((focus.sheetWidth || 160) * zoom) + 'px ' + ((focus.sheetHeight || 90) * zoom) + 'px',
                  backgroundRepeat: 'no-repeat',
                },
              })
              : h('img', { key: 'img', src: focus.url, alt: focus.label || '预览' }),
            h('button', {
              key: 'back', type: 'button', className: 'sm-btn', onClick: () => setFocus(null),
            }, '返回网格'),
          ])
          : h('div', { key: 'grid', className: 'sm-surf-gallery-grid' }, items.map((still, i) => h(StillThumb, {
            key: 'g' + i,
            still,
            onOpen: (s) => setFocus(s),
          }))),
        h('button', {
          key: 'close', type: 'button', className: 'sm-btn sm-surf-lightbox-close', onClick: onClose,
        }, '关闭'),
      ]),
    ])
  }

  return h('div', {
    className: 'sm-surf-lightbox',
    role: 'dialog',
    'aria-modal': 'true',
    onClick: onClose,
  }, [
    h('div', {
      key: 'inner',
      className: 'sm-surf-lightbox-inner',
      onClick: (event) => event.stopPropagation(),
    }, [
      active && active.kind === 'crop'
        ? h('div', {
          key: 'crop',
          className: 'sm-surf-lightbox-crop',
          style: {
            width: (active.width || 160) * zoom,
            height: (active.height || 90) * zoom,
            backgroundImage: cssUrl(active.url),
            backgroundPosition: '-' + ((active.x || 0) * zoom) + 'px -' + ((active.y || 0) * zoom) + 'px',
            backgroundSize: ((active.sheetWidth || 160) * zoom) + 'px ' + ((active.sheetHeight || 90) * zoom) + 'px',
            backgroundRepeat: 'no-repeat',
          },
        })
        : h('img', { key: 'img', src: (active && active.url) || shot.url, alt: (active && active.label) || shot.label || '预览' }),
      h('button', {
        key: 'close', type: 'button', className: 'sm-btn sm-surf-lightbox-close', onClick: onClose,
      }, '关闭'),
    ]),
  ])
}

module.exports = { SurfLightbox, StillThumb, stillUrl, cssUrl, openShotFromStill }
