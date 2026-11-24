// Small presentational pieces of the persona workshop page, split out of
// panel.mjs to keep every browser module under the 600-line ceiling.
const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

// DeepSeek brand whale (same geometry as harness `FISH_LOGO_PATH` / cover mark),
// remapped into a square 24×24 so the sidebar rail stays optically even with
// neighbouring outline icons. Filled `currentColor` follows light/dark theme.
const DEEPSEEK_WHALE_PATH = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45'

/** The sidebar glyph: DeepSeek whale mark in `currentColor`. */
function SoulmatePanelIcon(props) {
  const size = Number(props && props.size) || 18
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, [
    h('path', { key: 'whale', d: DEEPSEEK_WHALE_PATH }),
  ])
}

/** Live preview of the bundled skin (settings → identity tab). Prefer idle video when shipped. */
function PetPreview(props) {
  const [url, setUrl] = React.useState(props.fallback || '')
  const [kind, setKind] = React.useState('img')
  const [frames, setFrames] = React.useState([])
  const [failed, setFailed] = React.useState(false)
  // The preview must show the pack the widget will actually play, so it follows the
  // draft's skin instead of always fetching the server default.
  const skin = props.skin || 'winterboy-chibi'
  React.useEffect(() => {
    let alive = true
    let timer = 0
    setUrl(props.fallback || '')
    setKind('img')
    setFrames([])
    setFailed(false)
    api('pet/manifest?skin=' + encodeURIComponent(skin)).then((m) => {
      if (!alive || !m || m.ok === false) return
      const videos = m.videoUrls || {}
      const videoSrc = videos.idle || Object.values(videos).find(Boolean) || null
      const frameUrls = Object.keys(m.frameUrls || {}).sort().map((id) => m.frameUrls[id])
      setFrames(frameUrls)
      if (videoSrc) {
        setKind('video')
        setUrl(videoSrc)
        return
      }
      if (!frameUrls.length) return
      let idx = 0
      setKind('img')
      setUrl(frameUrls[0])
      timer = setInterval(() => { idx = (idx + 1) % frameUrls.length; setUrl(frameUrls[idx]) }, 850)
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => { alive = false; clearInterval(timer) }
  }, [skin, props.fallback])
  if (kind === 'video' && url) {
    return h('video', {
      className: 'sm-sprite-preview',
      src: url,
      muted: true,
      autoPlay: true,
      loop: true,
      playsInline: true,
      'aria-label': '桌面宠物预览',
      onError: () => {
        setKind('img')
        setUrl(frames[0] || props.fallback || '')
        if (!frames[0] && !props.fallback) setFailed(true)
      },
    })
  }
  if (!url) {
    return h('div', {
      className: 'sm-sprite-preview empty',
      role: 'img',
      'aria-label': failed ? '皮肤预览加载失败' : '正在加载皮肤预览',
    }, failed ? '预览加载失败' : '加载中…')
  }
  return h('img', {
    className: 'sm-sprite-preview',
    src: url,
    alt: '桌面宠物预览',
    onError: () => {
      if (url !== props.fallback && props.fallback) setUrl(props.fallback)
      else setFailed(true)
    },
  })
}

module.exports = { SoulmatePanelIcon, PetPreview }
