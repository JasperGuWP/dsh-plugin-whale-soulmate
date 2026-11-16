// Small presentational pieces of the persona workshop page, split out of
// panel.mjs to keep every browser module under the 600-line ceiling.
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

/** The sidebar glyph: a tiny whale in `currentColor`, so it follows the host theme. */
function SoulmatePanelIcon(props) {
  const size = Number(props && props.size) || 18
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, [
    h('path', {
      key: 'body',
      d: 'M3.6 12.3c0-3.6 3.5-6.5 8.1-6.5 3.7 0 6.8 2 7.7 4.7l2.1-.8c.5-.2.95.4.7.85l-1.6 2.5c-.15.25-.45.35-.72.25l-1.4-.5c-.9 2.5-3.6 4.2-6.8 4.2-4.5 0-8.1-2.1-8.1-4.7Z',
    }),
    h('circle', { key: 'eye', cx: 8.6, cy: 11.1, r: 1.05, fill: 'currentColor', stroke: 'none' }),
    h('path', { key: 'spout', d: 'M11.6 5.9c-.3-1.1.3-2 1.3-2.4' }),
  ])
}

/** Live preview of the bundled skin (settings → identity tab). Prefer idle video when shipped. */
function PetPreview(props) {
  const [url, setUrl] = React.useState('')
  const [kind, setKind] = React.useState('img')
  // The preview must show the pack the widget will actually play, so it follows the
  // draft's skin instead of always fetching the server default.
  const skin = props.skin || 'winterboy-chibi'
  React.useEffect(() => {
    let alive = true
    let timer = 0
    setUrl('')
    setKind('img')
    api('pet/manifest?skin=' + encodeURIComponent(skin)).then((m) => {
      if (!alive || !m || m.ok === false) return
      const videos = m.videoUrls || {}
      const videoSrc = videos.idle || Object.values(videos).find(Boolean) || null
      if (videoSrc) {
        setKind('video')
        setUrl(videoSrc)
        return
      }
      const frames = Object.keys(m.frameUrls || {}).sort().map((id) => m.frameUrls[id])
      if (!frames.length) return
      let idx = 0
      setKind('img')
      setUrl(frames[0])
      timer = setInterval(() => { idx = (idx + 1) % frames.length; setUrl(frames[idx]) }, 850)
    })
    return () => { alive = false; clearInterval(timer) }
  }, [skin])
  if (kind === 'video' && url) {
    return h('video', {
      className: 'sm-sprite-preview',
      src: url,
      muted: true,
      autoPlay: true,
      loop: true,
      playsInline: true,
      'aria-label': '桌面宠物预览',
    })
  }
  return h('img', { className: 'sm-sprite-preview', src: url || props.fallback || '', alt: '桌面宠物预览' })
}

module.exports = { SoulmatePanelIcon, PetPreview }
