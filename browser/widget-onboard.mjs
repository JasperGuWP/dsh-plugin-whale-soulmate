// Widget 30s onboarding — the approved balloon card from
// D:\agent\gender-balloons\index.html, ported 1:1 into the plugin:
// cream-light scene, inflated ♂/♀ canvas balloons (bob / squash / ✓ badge),
// countdown chip, nickname input, dark confirm + confetti, sound chip (default on).
// Flow: gender → filtered personality cards → auto-save → 30s countdown → confirm.
const { api, el, PRESET_FALLBACK, ONBOARD_SECONDS } = require('./util.mjs')
const { paintBalloonMini } = require('./balloon-sprite.mjs')
const { sfx, isMuted, setMuted, armAudio } = require('./onboard-sfx.mjs')

const CONFETTI_COLS = ['#2f6bff', '#e0447f', '#ffc24b', '#3ddc97', '#7fb1ff', '#ff9cc6']

/** Warm light blobs drifting behind the cream card (reference .card-zone). */
function sceneDecor() {
  return el('div', { class: 'sm-onb-scene', 'aria-hidden': 'true' }, [
    el('i', { class: 'sm-onb-blob b1' }),
    el('i', { class: 'sm-onb-blob b2' }),
    el('i', { class: 'sm-onb-blob b3' }),
  ])
}

function confettiBurst(host) {
  for (let i = 0; i < 36; i += 1) {
    const bit = el('span', { class: 'sm-onb-confetti' })
    bit.style.background = CONFETTI_COLS[i % CONFETTI_COLS.length]
    host.appendChild(bit)
    const a = (Math.random() - 0.5) * 2.4
    const d = 90 + Math.random() * 160
    const anim = bit.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${Math.sin(a) * d}px,${Math.cos(a) * d * 0.7 + 120}px) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 600, easing: 'cubic-bezier(.2,.7,.3,1)' })
    anim.onfinish = () => bit.remove()
  }
}

/**
 * Mount the onboarding overlay under `root`. Mutates `state` via callbacks.
 * @returns {{ box: HTMLElement, destroy: () => void }}
 */
function startWidgetOnboarding({ root, getSnapshot, setSnapshot, render, onDone }) {
  const snap0 = getSnapshot() || {}
  const allPresets = snap0.presets && snap0.presets.length ? snap0.presets : PRESET_FALLBACK
  let gender = null
  let chosen = null
  let remaining = ONBOARD_SECONDS
  let timer = 0
  let finished = false
  let disarmAudio = null

  const cd = el('span', { class: 'sm-onb-cd', hidden: true }, '')
  const soundTxt = el('span', { text: isMuted() ? '已静音' : '声音 开' })
  const soundBtn = el('button', {
    class: 'sm-onb-sound', type: 'button', 'aria-pressed': String(!isMuted()),
    title: '开关音效',
    onclick: () => {
      setMuted(!isMuted())
      soundBtn.setAttribute('aria-pressed', String(!isMuted()))
      soundTxt.textContent = isMuted() ? '已静音' : '声音 开'
    },
  }, [el('i', { class: 'sm-onb-sound-dot' }), soundTxt])

  const prog = el('i', { style: 'width:6%' })
  const nameInput = el('input', { class: 'sm-onb-nick', placeholder: '想让伙伴怎么称呼你？（可留空）', maxlength: 16 })
  const genderPick = el('div', { class: 'sm-onb-genders' })
  const grid = el('div', { class: 'sm-presets sm-onb-presets' })
  const confirmBtn = el('button', { class: 'sm-onb-confirm', type: 'button', text: '就是 TA 了' })
  const body = el('div', { class: 'sm-onb-box' })
  const box = el('div', { class: 'sm-onb' }, [sceneDecor(), body])

  function filteredPresets() {
    if (!gender) return []
    return allPresets.filter((p) => p.gender === gender)
  }

  function startCountdown() {
    remaining = ONBOARD_SECONDS
    cd.hidden = false
    cd.classList.remove('saved')
    cd.textContent = ONBOARD_SECONDS + 's 后自动保存'
    prog.style.width = '38%'
    clearInterval(timer)
    timer = setInterval(() => {
      if (!gender || !chosen || finished) return
      remaining -= 1
      prog.style.width = Math.max(6, 38 + (1 - remaining / ONBOARD_SECONDS) * 58) + '%'
      if (remaining <= 0) {
        clearInterval(timer)
        cd.textContent = '已自动保存 ✓'
        cd.classList.add('saved')
        sfx.chime()
        finish()
      } else {
        cd.textContent = remaining + 's 后自动保存'
      }
    }, 1000)
  }

  async function save(complete) {
    if (!gender || !chosen) return null
    const data = await api('onboard', {
      gender,
      preset: chosen.id,
      callUser: nameInput.value.trim() || undefined,
      complete,
    })
    if (data && data.ok !== false) {
      setSnapshot(Object.assign({}, getSnapshot() || {}, data))
      render()
    }
    return data
  }

  async function finish() {
    if (finished || !gender || !chosen) return
    finished = true
    clearInterval(timer)
    await save(true)
    destroy()
    onDone()
  }

  function shake() {
    body.classList.remove('shake')
    void body.offsetWidth
    body.classList.add('shake')
  }

  function paintGender() {
    genderPick.textContent = ''
    ;[
      { id: 'male', word: '男生', cls: 'm' },
      { id: 'female', word: '女生', cls: 'f' },
    ].forEach((opt) => {
      const cv = el('canvas', { width: 156, height: 156, class: 'sm-onb-balloon' + (opt.id === 'female' ? ' f' : '') })
      paintBalloonMini(cv, opt.id)
      const btn = el('button', {
        class: 'sm-onb-gbtn ' + opt.cls,
        type: 'button',
        'aria-pressed': String(gender === opt.id),
        'aria-label': '选择' + opt.word,
        onclick: () => {
          gender = opt.id
          const list = filteredPresets()
          chosen = list[0] || null
          sfx.boing()
          cv.classList.remove('boing')
          void cv.offsetWidth
          cv.classList.add('boing')
          paintGender()
          paintPresets()
          confirmBtn.textContent = '就是 TA 了'
          confirmBtn.classList.remove('done')
          startCountdown()
          if (chosen) save(false)
        },
      }, [cv, el('span', { class: 'sm-onb-check', text: '✓' }), el('span', { class: 'sm-onb-glabel', text: opt.word })])
      genderPick.appendChild(btn)
    })
  }

  function paintPresets() {
    grid.textContent = ''
    filteredPresets().forEach((preset, i) => {
      grid.appendChild(el('button', {
        class: 'sm-preset' + (chosen && preset.id === chosen.id ? ' on' : ''),
        type: 'button',
        style: `animation-delay:${i * 0.06}s`,
        onclick: () => {
          chosen = preset
          sfx.boing()
          paintPresets()
          save(false)
        },
      }, [
        el('b', { text: (preset.emoji || '') + ' ' + (preset.name || preset.id) }),
        el('span', { text: preset.title || preset.description || '' }),
      ]))
    })
  }

  confirmBtn.addEventListener('click', () => {
    if (!gender || !chosen) {
      shake()
      sfx.pop()
      cd.hidden = false
      cd.textContent = '先选一个性别气球哦'
      return
    }
    clearInterval(timer)
    cd.hidden = false
    cd.textContent = '已保存 ✓'
    cd.classList.add('saved')
    prog.style.width = '100%'
    confirmBtn.textContent = '已确认 ✓'
    confirmBtn.classList.add('done')
    sfx.chime()
    confettiBurst(body)
    setTimeout(() => finish(), 650)
  })

  function destroy() {
    clearInterval(timer)
    if (disarmAudio) disarmAudio()
    if (box.parentNode) box.parentNode.removeChild(box)
  }

  body.appendChild(el('div', { class: 'sm-onb-top' }, [
    el('span', { class: 'sm-onb-ico', 'aria-hidden': 'true' }),
    el('h2', { text: '认识一下你的小伙伴' }),
    cd,
    soundBtn,
  ]))
  body.appendChild(el('p', { class: 'sm-onb-desc', text: '先选伙伴的性别，再选性格；剩下的都会自动保存。选完性别后开始 ' + ONBOARD_SECONDS + ' 秒倒计时，随时可以在「换装」里改。' }))
  body.appendChild(el('div', { class: 'sm-onb-progress' }, [prog]))
  body.appendChild(genderPick)
  body.appendChild(grid)
  body.appendChild(nameInput)
  body.appendChild(el('div', { class: 'sm-onb-foot' }, [
    el('button', {
      class: 'sm-onb-later',
      type: 'button',
      text: '稍后再说',
      onclick: () => {
        try { window.sessionStorage.setItem('dsh-soulmate-onboard-skip', '1') } catch (_) { /* ignore */ }
        finished = true
        destroy()
        onDone()
      },
    }),
    confirmBtn,
  ]))
  nameInput.addEventListener('change', () => save(false))
  paintGender()
  paintPresets()
  root.appendChild(box)
  disarmAudio = armAudio()

  return { box, destroy }
}

module.exports = { startWidgetOnboarding }
