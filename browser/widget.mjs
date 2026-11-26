// Floating corner companion: avatar-only card + desktop-pet sprite layer.
const { el, api, POLL_MS, POLL_FAST_MS } = require('./util.mjs')
const { drawAvatar } = require('./avatar.mjs')
const { startWidgetOnboarding } = require('./widget-onboard.mjs')
const { videoUrlFor, isOnceState, endedCue, prefersMov } = require('./pet-video.mjs')
const { createPetRig } = require('./pet-rig.mjs')
const { createPetStage } = require('./pet-stage.mjs')
const { gestureSayPool } = require('./pet-says.mjs')
const { wirePetDrag } = require('./pet-drag.mjs')
const { createPetThrow } = require('./pet-throw.mjs')
const { isOpaquePetPixel } = require('./pet-hit.mjs')
const { createPetBubble } = require('./pet-bubble.mjs')

    // ------------------------------------------------------------------
    // Floating widget
    // ------------------------------------------------------------------
    function createWidget() {
      let snapshot = null
      let minimized = false
      let destroyed = false
      let pollTimer = 0
      let rafId = 0
      let onboarding = null
      let busy = false

      const root = el('div', { class: 'sm-root' })
      document.body.appendChild(root)

      const canvas = el('canvas', { class: 'sm-avatar', width: 140, height: 140 })
      const spriteImg = el('img', { class: 'sm-avatar-sprite', alt: '精灵', style: 'display:none', draggable: 'false' })
      spriteImg.draggable = false
      // Desktop-pet speech bubble (独立窗口形态 only). In-page corner bubble stays retired:
      // greets there go to OS toast / 专属窗. Turn card shelved — keep turn-card.mjs for later.
      let petBubble = null
      function showPetSay(say) {
        if (!petBubble || !say) return
        const text = typeof say === 'object' ? say.text : say
        const at = typeof say === 'object' ? say.at : ''
        // Dots are a loading indicator, not a truncation marker: only the preview line
        // (model still working) animates; the settled reply is clipped with no dots.
        const loading = typeof say === 'object' && say.preview === true
        petBubble.show(text, { at, loading })
      }
      // Local say lines live in pet-says.mjs (persona-aware pools + trait heuristics).
      function gesturePool(kind) {
        return gestureSayPool(snapshot && snapshot.config && snapshot.config.persona, kind)
      }
      let petClickTimer = 0
      // After a drag, swallow the click synthesized from that pointer sequence (not the next real tap).
      let swallowClick = false
      function pickSay(pool) {
        return pool[Math.floor(Math.random() * pool.length)] || pool[0]
      }
      function petGesture(kind) {
        const t = performance.now()
        if (kind === 'tap') {
          petEvent('click', t)
          doInteract('tap', pickSay(gesturePool('tap')))
        } else {
          petEvent('dblclick', t)
          doInteract('nuzzle', pickSay(gesturePool('nuzzle')))
        }
      }
      // Free-floating sticker: 16:9 stage + hit box (video fills stage; PNG only as fallback).
      const petStage = createPetStage({ spriteImg, canvas })
      const stageEl = petStage.stage
      const hitEl = petStage.hit
      hitEl.addEventListener('click', (e) => {
        if (swallowClick) {
          swallowClick = false
          e.preventDefault()
          e.stopPropagation()
          return
        }
        clearTimeout(petClickTimer)
        petClickTimer = setTimeout(() => petGesture('tap'), 280)
      })
      hitEl.addEventListener('dblclick', (e) => {
        e.preventDefault()
        clearTimeout(petClickTimer)
        petClickTimer = 0
        if (swallowClick) { swallowClick = false; return }
        petGesture('nuzzle')
      })
      const card = el('div', { class: 'sm-card sm-card-avatar' }, [
        stageEl,
      ])
      const widget = el('div', { class: 'sm-widget sm-widget-avatar' }, [card])
      const killNativeDrag = (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          if (e.dataTransfer) {
            e.dataTransfer.setData('text/plain', '')
            e.dataTransfer.setDragImage(document.createElement('canvas'), 0, 0)
          }
        } catch (_) { /* optional */ }
      }
      widget.addEventListener('dragstart', killNativeDrag, true)
      stageEl.addEventListener('dragstart', killNativeDrag, true)
      spriteImg.addEventListener('dragstart', killNativeDrag, true)
      hitEl.addEventListener('dragstart', killNativeDrag, true)
      // Free wheel-zoom within the configured range; persists debounced so scrolling
      // never spams the config writer.
      let petSizeSaveTimer = 0
      function onPetWheel(e) {
        if (!pet) return
        e.preventDefault()
        e.stopPropagation()
        const cur = Math.round(Number(pet.cfg.sizePx) || 148)
        const next = Math.min(320, Math.max(96, cur - Math.sign(e.deltaY) * 8))
        if (next === cur) return
        pet.cfg.sizePx = next
        petApplyFaces(performance.now())
        clearTimeout(petSizeSaveTimer)
        petSizeSaveTimer = setTimeout(() => { api('config', { pet: { sizePx: next } }) }, 400)
      }
      // Wheel must bind to hit (widget is pointer-events:none).
      hitEl.addEventListener('wheel', onPetWheel, { passive: false })

      // Drag wiring is installed after pet/petLayer locals exist (see below).
      const miniCanvas = el('canvas', { width: 88, height: 88 })
      const miniSprite = el('img', { class: 'sm-avatar-sprite', alt: '精灵', style: 'display:none;width:44px;height:44px', draggable: 'false' })
      miniSprite.draggable = false
      const mini = el('button', { class: 'sm-mini', title: '展开小伙伴', onclick: () => setMinimized(false) }, [miniCanvas, miniSprite])
      root.appendChild(widget)

      // ---------------- Desktop-pet sprite engine (browser mirror of pet-machine.mjs) ----------------
      // Timings come from the served pet.json manifest so config cannot drift from the
      // Node-side pure machine; only the driver is duplicated (ModuleLoader can't import ESM).
      let pet = null
      let petStarting = false
      let petLayer = null
      let petMotion = null
      let petThrow = null
      let wantMov = false
      try { wantMov = prefersMov(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) } catch (_) { /* no navigator in tests */ }
      const reducedMotion = () => {
        try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (_) { return false }
      }
      function petVideoUrl(state) {
        if (!pet || pet.videoBroken[state]) return null
        return videoUrlFor(pet.manifest, state, wantMov)
      }
      // Any front video buffer still owns the pixels — including the brief window
      // after petVideoEnter sets videoState to the next clip but before A/B swap.
      // Matching on videoState===activeState here un-hides the PNG while the old
      // clip is still .is-front → double silhouette / "zoom flash" on drag.
      function petVideoShowing() {
        return !!(petLayer && petLayer.activeState())
      }
      /** Load the state's video if shipped; once states suppress the dwell timer. */
      function petVideoEnter(name, t) {
        if (!pet || !petLayer) return
        const st = (pet.manifest.states || {})[name] || {}
        const url = petVideoUrl(name)
        if (!url) { pet.videoState = null; petLayer.hide(); return }
        pet.videoState = name
        petLayer.load(name, url, { once: isOnceState(st), mirror: (name === 'walk' || name === 'run') && mirrorFor(st, pet.m.facing) })
      }
      function petCfgOf(snap) {
        const p = snap && snap.config && snap.config.pet
        return p && p.enabled ? p : null
      }
      // 素材原生朝向按 state 声明(video.faces,缺省 left):镜像条件随之反转,
      // 否则原生朝右的 run 视频向左移动时不镜像=倒着跑。
      function mirrorFor(st, facing) {
        const v = st && st.video
        const faces = (v && typeof v === 'object' && v.faces) || 'left'
        return faces === 'left' ? facing === 1 : facing === -1
      }
      function petDwellMs(st) {
        const d = st && st.dwellSec
        if (Array.isArray(d) && d.length) {
          const lo = Number(d[0]) || 0
          const hi = Number(d[1] || d[0]) || lo
          return (lo + Math.random() * Math.max(0, hi - lo)) * 1000
        }
        return (Number(st && st.holdSec) || 0) * 1000
      }
      function petEnter(m, name, t) {
        const states = (pet && pet.manifest.states) || {}
        if ((m.state === 'walk' || m.state === 'run') && name !== m.state && petMotion) petMotion.stop()
        m.state = states[name] ? name : 'idle'
        m.idx = 0
        m.enteredAt = t
        m.switchAt = t + petDwellMs(states[m.state])
        if (m.state === 'walk' || m.state === 'run') {
          m.facing = Math.random() < 0.5 ? -1 : 1
          // Plan the real locomotion now; facing follows the travel direction.
          if (petMotion) {
            const st = states[m.state] || {}
            const v = st.video && typeof st.video === 'object' ? st.video : {}
            const plan = petMotion.plan({
              speedPxSec: Number(st.speedPxSec) || (m.state === 'run' ? 120 : 40),
              dwellMs: petDwellMs(st),
              leadSec: Number(v.leadSec) || 0,
              tailSec: Number(v.tailSec) || 0,
            })
            if (plan) m.facing = plan.facing
          }
        }
        if (m.state === 'idle') m.blinkAt = t + 1200 + Math.random() * 2600
        petVideoEnter(m.state, t)
      }
      function petEvent(name, t, vel) {
        if (!pet) return
        const m = pet.m
        m.lastAct = t
        if (name === 'walk') { petEnter(m, 'walk', t); return }
        if (name === 'think') { petEnter(m, 'think', t); return }
        if (name === 'eureka') { petEnter(m, 'eureka', t); return }
        if (name === 'dragStart') { m.dragging = true; if (petMotion) petMotion.stop(); petEnter(m, 'drag', t); return }
        if (name === 'dragEnd') {
          m.dragging = false
          if (petMotion) petMotion.stop()
          // A fast release becomes a flick-throw: keep the dangle pose in flight
          // (m.dragging suppresses dwell switches); onRest lands her into happy.
          if (petThrow && vel) {
            const rect = widget.getBoundingClientRect()
            if (petThrow.start(rect.left, rect.top, vel.vx, vel.vy)) { m.dragging = true; return }
          }
          petEnter(m, 'happy', t)
          return
        }
        if (name === 'turn') { m.facing = -m.facing; return }
        if (m.state === 'sleep') { petEnter(m, 'happy', t); return }
        if (name === 'click') petEnter(m, 'wave', t)
        else if (name === 'dblclick') petEnter(m, 'happy', t)
      }
      // 桌面窗口形态:preload 桥(仅透明窗内存在);身体矩形/忙碌态供主进程兜底泵判穿透
      const petWindowBridge = (typeof window !== 'undefined' && window.__smPetWindow && window.smPetWindow) || null
      let petWindowScreens = null
      if (petWindowBridge) {
        try { petWindowScreens = JSON.parse(new URLSearchParams(window.location.search).get('screens') || 'null') } catch (_) { petWindowScreens = null }
        // Speech bubble rides above the pet; the transparent window lets it sit over
        // otherwise click-through space, so its rect joins the body hit rect below.
        petBubble = createPetBubble({ doc: document, mount: card })
      }
      let lastBodySend = 0
      // 光标位置:宠物自己走/飞到静止光标底下时,靠它每帧重采 alpha,穿透判定不滞后
      let lastPointer = null
      if (petWindowBridge) {
        window.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY } }, { passive: true })
        // 主进程每拍送光标(穿透期 forward 钩子可能失效,渲染端自己收不到 move)
        if (typeof petWindowBridge.onCursor === 'function') {
          petWindowBridge.onCursor((p) => { lastPointer = { x: p.x - window.screenX, y: p.y - window.screenY } })
        }
      }
      wirePetDrag({
        widget,
        hitEl,
        spriteImg,
        getPet: () => pet,
        getPetLayer: () => petLayer,
        // Catch a flying pet: freeze it where it is, then let the normal
        // click/drag flow take over (a real drag re-enters via dragStart).
        onGrab: () => {
          if (petThrow && petThrow.active()) {
            petThrow.stop()
            if (pet) { pet.m.dragging = false; petEnter(pet.m, 'happy', performance.now()) }
          }
        },
        onDragStart: (t) => petEvent('dragStart', t),
        onDragEnd: (t, vel) => petEvent('dragEnd', t, vel),
        onHit: (on) => { if (petWindowBridge) petWindowBridge.setHit(pet ? on : false) },
        setSwallow: (v) => { swallowClick = !!v },
      })
      function petFrameAt(t) {
        const m = pet.m
        const states = pet.manifest.states || {}
        const st = states[m.state] || {}
        if ((m.state === 'walk' || m.state === 'run') && !m.dragging) {
          const fps = Number(st.fps) || 6
          const frames = st.frames || []
          if (frames.length) m.idx = Math.floor((t - m.enteredAt) / (1000 / fps)) % frames.length
        }
        if (m.state === 'think') {
          const fps = Number(st.fps) || 2
          const frames = st.frames || []
          if (frames.length) m.idx = Math.floor((t - m.enteredAt) / (1000 / fps)) % frames.length
          if (t - m.enteredAt >= (Number(st.maxSec) || 120) * 1000) petEnter(m, 'idle', t)
        }
        // Once-states with a shipped (non-broken) video are driven by `ended`, not the
        // dwell timer — suppress dwell while loading/playing; a frame-time watchdog
        // (holdSec + 10s) recovers a lost ended. No new setTimeout (§5.3 / 审核 #24).
        const onceVideoPending = isOnceState(st) && !!petVideoUrl(m.state)
        if (onceVideoPending) {
          if (t - m.enteredAt >= (Number(st.holdSec) || 0) * 1000 + 10000) {
            petEnter(m, endedCue(states, m.state, Math.random) || 'idle', t)
          }
        } else if (!m.dragging && t >= m.switchAt && m.state !== 'sleep' && m.state !== 'think') {
          const idleFor = t - m.lastAct
          if ((m.state === 'idle' || m.state === 'sit') && states.sleep && idleFor >= (Number(pet.cfg.sleepAfterIdleSec) || 300) * 1000) {
            petEnter(m, 'sleep', t)
          } else if (m.state === 'idle' && pet.cfg.ambientWalk !== false && !reducedMotion() && states.walk
            && idleFor >= (Number.isFinite(Number(pet.cfg.ambientWalkAfterSec)) ? Number(pet.cfg.ambientWalkAfterSec) : 15) * 1000
            && Math.random() < (Number.isFinite(Number(pet.cfg.ambientWalkChance)) ? Number(pet.cfg.ambientWalkChance) : 0.35)) {
            // 闲置自主散步:没人理她时自己走起来(walk 视频 + 位移)
            petEnter(m, 'walk', t)
          } else if (st.next && Object.keys(st.next).length) {
            let roll = Math.random()
            let pick = null
            for (const entry of Object.entries(st.next)) {
              if (roll < entry[1]) { pick = entry[0]; break }
              roll -= entry[1]
            }
            petEnter(m, pick || 'idle', t)
          } else {
            petEnter(m, 'idle', t)
          }
        }
        const cur = states[m.state] || {}
        // Video owns the pixels → suppress the PNG blink channel (§5.4b); it returns
        // automatically once we fall back to PNG.
        const videoOwnsPixels = petVideoShowing()
        if (m.state === 'idle' && cur.blink && !videoOwnsPixels) {
          const blinkMs = (Number(cur.blinkSec) || 0.12) * 1000
          if (t >= m.blinkAt && t < m.blinkAt + blinkMs) return { id: cur.blink, mirror: false }
          if (t >= m.blinkAt + blinkMs) m.blinkAt = t + 1500 + Math.random() * 2600
        }
        const frames = cur.frames || ['pet-idle-01']
        return { id: frames[m.idx % frames.length], mirror: (m.state === 'walk' || m.state === 'run') && mirrorFor(cur, m.facing) }
      }
      function petApplyFaces(t) {
        if (!pet) return
        const face = petFrameAt(t)
        const url = pet.urls[face.id]
        if (!url) return
        const size = Math.round(Number(pet.cfg.sizePx) || 148)
        petStage.setSize(size)
        miniSprite.style.transform = face.mirror ? 'scaleX(-1)' : ''
        if (miniSprite.getAttribute('src') !== url) miniSprite.setAttribute('src', url)
        const videoOn = petVideoShowing()
        if (videoOn) {
          petStage.setSpriteVisible(false)
        } else {
          petStage.setSpriteVisible(true)
          spriteImg.style.transform = face.mirror ? 'scaleX(-1)' : ''
          if (spriteImg.getAttribute('src') !== url) spriteImg.setAttribute('src', url)
        }
        if (petLayer) {
          petLayer.setMirror(face.mirror)
          petLayer.setSize(size)
        }
      }
      async function startPet(cfg) {
        const manifest = await api('pet/manifest?skin=' + encodeURIComponent(cfg.skin || 'winterboy-chibi'))
        if (destroyed || !manifest || manifest.ok === false) return
        const urls = manifest.frameUrls || {}
        await Promise.all(Object.keys(urls).map((id) => new Promise((resolve) => {
          const im = new Image()
          im.onload = resolve
          im.onerror = resolve
          im.src = urls[id]
        })))
        if (destroyed) return
        const t = performance.now()
        const m = { state: 'idle', idx: 0, facing: -1, dragging: false, enteredAt: t, switchAt: t, blinkAt: t, lastAct: t }
        pet = { manifest, urls, cfg, m, videoState: null, videoBroken: {} }
        if (!petLayer) {
          const rig = createPetRig({
            mount: petStage.videoMount,
            root: () => widget,
            viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
            size: () => (pet ? petStage.width() : Math.round(148 * 16 / 9)),
            height: () => (pet ? petStage.height() : 148),
            screens: () => petWindowScreens,
            isDragging: () => !!(pet && pet.m.dragging),
            isMinimized: () => minimized,
            reducedMotion,
            getPet: () => pet,
            petVideoUrl,
            petDwellMs,
            enter: (name, now) => petEnter(pet.m, name, now),
            applyFaces: petApplyFaces,
            now: () => performance.now(),
          })
          petLayer = rig.layer
          petMotion = rig.motion
          // Keep hit above video buffers for stacking (pointer-events still on hit only).
          if (hitEl.parentNode === petStage.videoMount) petStage.videoMount.appendChild(hitEl)
        }
        if (!petThrow) {
          petThrow = createPetThrow({
            root: () => widget,
            stage: () => stageEl,
            viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
            size: () => ({ width: petStage.width(), height: petStage.height() }),
            screens: () => petWindowScreens,
            physics: () => (pet ? pet.cfg.physics : null),
            reducedMotion,
            onRest: (t) => { if (pet) { pet.m.dragging = false; petEnter(pet.m, 'happy', t) } },
          })
        }
        petLayer.setPaused(document.hidden)
        petEnter(m, 'idle', t)
        syncSpriteFaces()
      }
      /** Freeze a flight mid-air and leave the dangle pose (minimize / tab hide). */
      function abortThrow() {
        if (petThrow && petThrow.active()) {
          petThrow.stop()
          if (pet) { pet.m.dragging = false; petEnter(pet.m, 'idle', performance.now()) }
        }
      }
      function stopPet() {
        if (petMotion) petMotion.stop()
        if (petThrow) petThrow.stop()
        if (petLayer) petLayer.clear()
        pet = null
        spriteImg.style.transform = ''
        miniSprite.style.transform = ''
        petStage.setSpriteVisible(true)
        syncSpriteFaces()
      }

      function spriteUrlOf(snap) {
        const url = snap && snap.config && snap.config.appearance && snap.config.appearance.customSpriteUrl
        return typeof url === 'string' && url.trim() ? url.trim() : ''
      }

      function syncSpriteFaces() {
        if (pet) {
          canvas.style.display = 'none'
          petStage.setSpriteVisible(!petVideoShowing())
          miniCanvas.style.display = 'none'
          miniSprite.style.display = ''
          mini.classList.add('sm-mini-sprite')
          return
        }
        const url = spriteUrlOf(snapshot)
        if (url) {
          canvas.style.display = 'none'
          spriteImg.style.display = ''
          if (spriteImg.getAttribute('src') !== url) spriteImg.setAttribute('src', url)
          miniCanvas.style.display = 'none'
          miniSprite.style.display = ''
          if (miniSprite.getAttribute('src') !== url) miniSprite.setAttribute('src', url)
          // Sprite art is already a sticker — drop the white tile behind the mini too.
          mini.classList.add('sm-mini-sprite')
        } else {
          canvas.style.display = ''
          spriteImg.style.display = 'none'
          miniCanvas.style.display = ''
          miniSprite.style.display = 'none'
          mini.classList.remove('sm-mini-sprite')
        }
      }

      function setMinimized(value) {
        minimized = value
        if (value) {
          abortThrow()
          if (petMotion) petMotion.stop()
          if (petLayer) petLayer.setPaused(true)
          if (widget.parentNode) root.removeChild(widget)
          root.appendChild(mini)
        } else {
          if (mini.parentNode) root.removeChild(mini)
          root.appendChild(widget)
          if (petLayer) petLayer.setPaused(document.hidden)
        }
      }

      function render() {
        if (!snapshot) return
        const cfg = petCfgOf(snapshot)
        if (cfg && !pet && !petStarting) {
          petStarting = true
          startPet(cfg).then(() => { petStarting = false }, () => { petStarting = false })
        }
        // Switching skin in the settings page must actually swap the frames; without
        // this the running sprite kept the pack it was started with until a reload.
        if (cfg && pet && (cfg.skin || 'winterboy-chibi') !== (pet.cfg.skin || 'winterboy-chibi') && !petStarting) {
          petStarting = true
          const previous = pet
          stopPet()
          startPet(cfg).then(() => { petStarting = false }, () => {
            petStarting = false
            // Keep the old pack rather than going blank if the new one fails to load.
            // The layer was cleared by stopPet — reset videoState or the video never
            // re-switches (审核 #7).
            if (!pet) { previous.videoState = null; pet = previous }
          })
        }
        if (!cfg && pet) stopPet()
        // Only the avatar is on screen now; `render` just keeps the sprite face in sync.
        syncSpriteFaces()
      }

      /** The floating widget has no readouts, so a failed poll just backs off silently. */

      function frame(time) {
        if (destroyed) return
        if (petWindowBridge && time - lastBodySend > 100) {
          lastBodySend = time
          const base = widget.getBoundingClientRect()
          const bubbleRect = petBubble && petBubble.visible() ? petBubble.rect() : null
          // The bubble can float over transparent window space; union its rect so the
          // main-process ignore pump keeps the pointer while it is over the bubble.
          let r = { x: base.x, y: base.y, w: base.width, h: base.height }
          if (bubbleRect) {
            const x = Math.min(base.left, bubbleRect.left)
            const y = Math.min(base.top, bubbleRect.top)
            r = {
              x,
              y,
              w: Math.max(base.right, bubbleRect.right) - x,
              h: Math.max(base.bottom, bubbleRect.bottom) - y,
            }
          }
          // busy 只算「手拿着」:m.dragging 在飞行期间也真(保持悬垂姿势),
          // 若把它当 busy,整窗会在飞行的几秒里收鼠标、挡住桌面点击。
          const busy = !!(pet && pet.m.dragging && !(petThrow && petThrow.active()))
          const overBubble = !!(petBubble && lastPointer && petBubble.contains(lastPointer.x, lastPointer.y))
          // 包围盒内透明余量也要穿透:hit=光标当前像素是否不透明(素材未就绪时按透明)
          const hit = overBubble || (!!pet && !!lastPointer && isOpaquePetPixel({
            clientX: lastPointer.x,
            clientY: lastPointer.y,
            frontVideo: () => (petLayer ? petLayer.frontVideo() : null),
            spriteImg,
            failClosed: false,
          }))
          petWindowBridge.setBody(r, busy, hit)
        }
        if (petThrow) petThrow.step(time)
        if (petMotion) petMotion.step(time)
        if (pet) petApplyFaces(time)
        if (!pet && !spriteUrlOf(snapshot)) {
          const appearance = snapshot && snapshot.config ? snapshot.config.appearance : null
          const mood = snapshot && snapshot.state ? snapshot.state.mood : 'neutral'
          drawAvatar(minimized ? miniCanvas : canvas, appearance, mood, time)
        }
        rafId = requestAnimationFrame(frame)
      }

      let retryDelay = 2000
      let retryTimer = 0
      let lastSessionId = null

      /** Poll fast while she is acting, calmly otherwise. */
      function schedulePoll() {
        if (destroyed) return
        clearTimeout(pollTimer)
        const acting = pet && (pet.m.state === 'think' || pet.m.state === 'eureka')
        pollTimer = setTimeout(async () => {
          await refresh()
          schedulePoll()
        }, acting ? POLL_FAST_MS : POLL_MS)
      }

      async function refresh() {
        if (destroyed || document.hidden) return
        const data = await api('state')
        if (destroyed) return
        if (!data || data.ok === false) {
          // Back off instead of hammering a host that is still booting.
          clearTimeout(retryTimer)
          retryTimer = setTimeout(refresh, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 60000)
          return
        }
        retryDelay = 2000
        clearTimeout(retryTimer)
        snapshot = data
        // Chat-driven acting: message → think loop; answer lands (petThinking drops) →
        // eureka immediately (interrupt think video — do not wait for loop end).
        if (pet) {
          const thinking = !!(data && data.petThinking)
          const phase = data && data.petTurnPhase
          const answerReady = !thinking || phase === 'done'
          if (thinking && phase !== 'done' && pet.m.state !== 'think' && pet.m.state !== 'eureka') {
            petEvent('think', performance.now())
          } else if (answerReady && pet.m.state === 'think') {
            petEvent('eureka', performance.now())
          }
        }
        // Walking is a conversation-switch gesture, not ambient filler: she pads a few
        // steps when you move to another conversation.
        const sessionId = data && data.sessionId ? String(data.sessionId) : null
        if (pet && sessionId && lastSessionId !== null && sessionId !== lastSessionId) {
          if (pet.m.state === 'idle' || pet.m.state === 'sit') petEvent('walk', performance.now())
        }
        if (sessionId) lastSessionId = sessionId
        if (data && data.petSay) showPetSay(data.petSay)
        render()
        maybeOnboard()
      }

      async function doInteract(action, sayText) {
        if (busy) return
        busy = true
        const data = await api('interact', { action })
        busy = false
        if (data && data.ok !== false) {
          snapshot = Object.assign({}, snapshot || {}, data)
          render()
          if (sayText) showPetSay({ text: sayText, at: new Date().toISOString() })
        }
      }

      // 3D 家园 overlay 暂停开发（openOverlay 已移除）；设置面板在宿主侧栏。
      // External trigger surface (tests / future runners):
      // window.dispatchEvent(new CustomEvent('dsh-soulmate:pet', { detail: { action: 'think' } }))
      const onPetSignal = (e) => {
        const a = e && e.detail && e.detail.action
        if (typeof a === 'string') petEvent(a, performance.now())
      }
      window.addEventListener('dsh-soulmate:pet', onPetSignal)

      function maybeOnboard() {
        if (onboarding || !snapshot || !snapshot.config) return
        if (snapshot.config.onboardingCompleted !== false) return
        try {
          if (window.sessionStorage.getItem('dsh-soulmate-onboard-skip') === '1') return
        } catch (_) { /* storage may be blocked */ }
        const session = startWidgetOnboarding({
          root,
          getSnapshot: () => snapshot,
          setSnapshot: (next) => { snapshot = next },
          render,
          onDone: () => { onboarding = null },
        })
        onboarding = session.box
      }

      // ---------------- lifecycle ----------------
      function onVisibility() {
        if (document.hidden) {
          // Hidden mid-walk: commit to the target first, then stop — otherwise the
          // video resumes on return while the position stayed frozen (审核 #21).
          if (petMotion && petMotion.active()) petMotion.commit()
          if (petMotion) petMotion.stop()
          abortThrow()
          if (petLayer) petLayer.setPaused(true)
        } else {
          if (petLayer) petLayer.setPaused(minimized)
          refresh()
        }
      }
      function onResize() {
        if (petMotion) petMotion.clamp()
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('resize', onResize)

      schedulePoll()
      rafId = requestAnimationFrame(frame)
      refresh()

      return function destroy() {
        destroyed = true
        clearTimeout(pollTimer)
        clearTimeout(retryTimer)
        cancelAnimationFrame(rafId)
        window.removeEventListener('dsh-soulmate:pet', onPetSignal)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('resize', onResize)
        if (petMotion) petMotion.stop()
        if (petThrow) petThrow.stop()
        if (petLayer) petLayer.dispose()
        if (root.parentNode) root.parentNode.removeChild(root)
      }
    }
module.exports = { createWidget }
