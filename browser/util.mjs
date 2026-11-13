// Shared constants and tiny DOM/HTTP helpers for the browser half.
    const KIND = 'dsh-plugins-soulmate'
    const API = '/dsh-soulmate/api/'
    // The pet must catch a *state change*, not just resync a status readout. Node keeps
    // `petThinking` latched for the whole reply and drops it on whenIdle (quiet window is
    // fallback only) — poll must still be fast enough to catch that falling edge.
    const POLL_MS = 2500
    // While she is mid-act (thinking / eureka) poll tightly, so eureka fires as soon as
    // the answer lands instead of up to a full interval later.
    const POLL_FAST_MS = 400
    const ONBOARD_SECONDS = 30
    const CSS_KEY = 'dsh-plugins-soulmate.css'

    const PRESET_FALLBACK = [
      { id: 'rice-whale', gender: 'female', emoji: '🐋', name: '干饭鲸鱼', title: '傲娇干饭魂', defaultCallUser: '搭档', defaultSelfRef: '本鱼' },
      { id: 'gentle-echo', gender: 'female', emoji: '🌙', name: '温柔回响', title: '安静陪伴', defaultCallUser: '你', defaultSelfRef: '我' },
      { id: 'geek-partner', gender: 'female', emoji: '⚡', name: '极客搭档', title: '先补丁后吐槽', defaultCallUser: '队长', defaultSelfRef: '我' },
      { id: 'yandere-claim', gender: 'female', emoji: '💗', name: '偏执占有你', title: '黏人护短', defaultCallUser: '你', defaultSelfRef: '本喵' },
      { id: 'blank-custom', gender: 'female', emoji: '🎨', name: '空白画布', title: '全部由你定义', defaultCallUser: '主人', defaultSelfRef: '我' },
      { id: 'quiet-guardian', gender: 'male', emoji: '🛡️', name: '沉静的守护者', title: '话少而稳', defaultCallUser: '你', defaultSelfRef: '我' },
      { id: 'cool-senpai', gender: 'male', emoji: '🧊', name: '冷感学长', title: '嫌弃里藏关心', defaultCallUser: '你', defaultSelfRef: '我' },
      { id: 'clingy-cyclone', gender: 'male', emoji: '🌪️', name: '黏人爱闹的小龙卷', title: '碎嘴不误事', defaultCallUser: '你', defaultSelfRef: '我' },
      { id: 'dark-hunter', gender: 'male', emoji: '🌑', name: '暗黑的猎手', title: '护短带刺', defaultCallUser: '你', defaultSelfRef: '我' },
      { id: 'blank-custom-male', gender: 'male', emoji: '✨', name: '纯白自塑灵魂', title: '全部由你定义', defaultCallUser: '你', defaultSelfRef: '我' },
    ]

    /** Browser-side mirror of soulmate-core companionPronoun (no ESM import). */
    function companionPronoun(gender) {
      if (gender === 'female') return { third: '她', presenceTitle: '# 她此刻记得' }
      if (gender === 'male') return { third: '他', presenceTitle: '# 他此刻记得' }
      return { third: '伙伴', presenceTitle: '# 我此刻记得' }
    }

    // Bond-stage thresholds (mirrors computeBondStage on the node half).
    const BOND_STEPS = [50, 200, 500, 900, 1000]
    function nextThreshold(affinity) {
      for (const step of BOND_STEPS) if (affinity < step) return step
      return BOND_STEPS[BOND_STEPS.length - 1]
    }

    const MOOD_FACE = { happy: '😊', content: '🙂', calm: '😌', sleepy: '😴', hungry: '🥺', sad: '😢', excited: '🤩', grumpy: '😤', neutral: '🙂' }
    async function api(path, body) {
      try {
        const init = body === undefined
          ? { headers: { accept: 'application/json' } }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        const res = await fetch(API + path, init)
        const text = await res.text()
        if (!text) {
          return {
            ok: false,
            error: '空响应 HTTP ' + res.status + '（node 半侧路由未挂上，通常需重启 DSH）',
          }
        }
        try {
          return JSON.parse(text)
        } catch (err) {
          return {
            ok: false,
            error: '非 JSON HTTP ' + res.status + '：' + text.slice(0, 120),
          }
        }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) }
      }
    }

    function el(tag, props, children) {
      const node = document.createElement(tag)
      if (props) {
        for (const key of Object.keys(props)) {
          const value = props[key]
          if (key === 'class') node.className = value
          else if (key === 'text') node.textContent = value
          else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
          else if (value !== undefined && value !== null) node.setAttribute(key, String(value))
        }
      }
      for (const child of children || []) {
        if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      return node
    }

    // ------------------------------------------------------------------
    // Tiny canvas avatar (4 forms, accessories, mood)
    // ------------------------------------------------------------------
    function safeColor(value, fallback) {
      return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback
    }

    const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

    /** Strip markdown chrome so diary / wiki paper reads as plain prose. */
    function plainMemoryText(raw) {
      return String(raw || '')
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*_]{3,}\s*$/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

module.exports = { KIND, API, POLL_MS, POLL_FAST_MS, ONBOARD_SECONDS, CSS_KEY, PRESET_FALLBACK, companionPronoun, BOND_STEPS, nextThreshold, MOOD_FACE, api, el, safeColor, clampNum, plainMemoryText }
