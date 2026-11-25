// Sidebar row + the tabbed persona workshop page (slot `main`).
const React = require('react')
const h = React.createElement
const { api, clampNum, PRESET_FALLBACK, API } = require('./util.mjs')
const { NeuronCard } = require('./panel-neuron-card.mjs')
const { drawAvatar } = require('./avatar.mjs')
const { deleteSprite } = require('./sprite.mjs')
const { statusCard, schedulingCard, personaCard } = require('./panel-cards.mjs')
const { usageCard } = require('./panel-usage.mjs')
const { diaryCard } = require('./panel-diary.mjs')
const { trustCard } = require('./panel-trust.mjs')
const {
  identityCard,
  gateCard: gateCardEl,
  traitsCard,
  skinFrameUrl,
  lookPetCard,
  rhythmCard: rhythmCardEl,
} = require('./panel-forms.mjs')
const {
  TRAIT_LABELS,
  DEFAULT_SPRITE_URL,
  DEFAULT_SPRITE_MALE_URL,
  draftFromSummary,
  draftSignature,
} = require('./panel-draft.mjs')
const { setMbtiTypeOnDraft, setMbtiAxisOnDraft, persistTraitSchemeSwitch, buildPersonaEvolvePayload, traitsCardInputs, useTraitsStatePoll } = require('./panel-mbti.mjs')
const { llmBudgetSection } = require('./panel-llm-budget.mjs')
const { UpdateBadge } = require('./panel-update.mjs')
const { OPEN_TAB_EVENT, consumePendingTab } = require('./panel-nav.mjs')
const { SoulmatePanelIcon, PetPreview } = require('./panel-preview.mjs')
const { surfCard: surfCardEl } = require('./panel-surf.mjs')
const { DsBotCard } = require('./panel-dsbot.mjs')
const { SoulShareCard } = require('./panel-soul-share.mjs')

    // Sidebar panel — 「小鱼」persona workshop (slot `main` + panellist row).
    const PANEL_ID = 'soulmate'
    const PANEL_ORDER = 5
    // Host panellist `label` is registration metadata — updated after a successful save via
    // `onSidebarLabelChange` (wired from apply). Draft typing must NOT flicker the sidebar.
    let onSidebarLabelChange = null
    const sidebarLabelOf = (name) => {
      const trimmed = typeof name === 'string' ? name.trim() : ''
      return trimmed || 'soulmate'
    }

/** The settings page: identity / traits / memory, split into tabs. */
    function SoulmatePanelPage() {
      const [snap, setSnap] = React.useState(null)
      const [engine, setEngine] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [tab, setTab] = React.useState(() => consumePendingTab() || 'surf')
      React.useEffect(() => {
        const onOpen = (ev) => {
          const next = String((ev && ev.detail && ev.detail.tab) || '').trim()
          if (next) setTab(next)
        }
        window.addEventListener(OPEN_TAB_EVENT, onOpen)
        const pending = consumePendingTab()
        if (pending) setTab(pending)
        return () => window.removeEventListener(OPEN_TAB_EVENT, onOpen)
      }, [])
      const canvasRef = React.useRef(null)
      const draftRef = React.useRef(null)
      const moodRef = React.useRef('neutral')
      // Must live with the other hooks — never after the empty-draft early return, or
      // React crashes on the first successful load and the settings page goes blank.
      const [spriteNote, setSpriteNote] = React.useState('')
      const [skinList, setSkinList] = React.useState(null)
      const [skinBusy, setSkinBusy] = React.useState(false)
      const [proStatus, setProStatus] = React.useState(null)
      const savedSigRef = React.useRef('')
      const savingRef = React.useRef(false)
      // Token tab state: the snapshot comes from GET /api/usage, the knobs are edited locally.
      const [usage, setUsage] = React.useState(null)
      const [usageDraft, setUsageDraft] = React.useState(null)
      const [usageBusy, setUsageBusy] = React.useState(false)
      const [usageNote, setUsageNote] = React.useState('')
      const [shelf, setShelf] = React.useState(null)
      const [diaryBook, setDiaryBook] = React.useState('toYou')
      const [diaryId, setDiaryId] = React.useState(null)
      const [quizBusy, setQuizBusy] = React.useState(false)
      const [quizMsg, setQuizMsg] = React.useState('')
      const [quizMsgKind, setQuizMsgKind] = React.useState('')
      const draftSig = draftSignature

      const load = React.useCallback(async () => {
        const [data, eng] = await Promise.all([api('state'), api('engine')])
        if (!data || data.ok === false) {
          setError((data && data.error) || '读取不到伙伴状态')
          return
        }
        setSnap(data)
        if (eng && eng.ok !== false) setEngine(eng)
        setError('')
        moodRef.current = (data.state && data.state.mood) || 'neutral'
        setDraft((prev) => {
          const next = draftFromSummary(data)
          if (!prev) { savedSigRef.current = draftSig(next); return next }
          if (draftSig(prev) !== savedSigRef.current) return prev
          savedSigRef.current = draftSig(next)
          return next
        })
      }, [])

      React.useEffect(() => { load() }, [load])
      // Skin catalog: fetched on mount and refreshed while the identity tab is
      // open, so a freshly copied skin folder shows up without a client rebuild.
      React.useEffect(() => {
        let alive = true
        const fetchSkins = () => api('pet/skins').then((s) => {
          if (alive && s && s.ok && Array.isArray(s.skins) && s.skins.length) setSkinList(s.skins)
        })
        fetchSkins()
        if (tab !== 'identity') return () => { alive = false }
        const timer = setInterval(fetchSkins, 15000)
        return () => { alive = false; clearInterval(timer) }
      }, [tab])
      useTraitsStatePoll(React, tab, load)
      React.useEffect(() => {
        if (tab !== 'rhythm') return undefined
        let alive = true
        const fetchStatus = () => { api('proactive/status').then((s) => { if (alive && s && s.ok !== false) setProStatus(s) }) }
        fetchStatus()
        const timer = setInterval(fetchStatus, 15000)
        return () => { alive = false; clearInterval(timer) }
      }, [tab])
      React.useEffect(() => {
        const timer = setInterval(() => {
          api('engine').then((eng) => { if (eng && eng.ok !== false) setEngine(eng) })
        }, 5000)
        return () => clearInterval(timer)
      }, [])
      draftRef.current = draft

      React.useEffect(() => {
        let raf = 0
        const tick = (time) => {
          const current = draftRef.current
          if (canvasRef.current && current && !(current.appearance && current.appearance.customSpriteUrl)) {
            drawAvatar(canvasRef.current, current.appearance, moodRef.current, time)
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
      }, [])

      React.useEffect(() => {
        if (!note) return undefined
        const timer = setTimeout(() => setNote(''), 3600)
        return () => clearTimeout(timer)
      }, [note])

      const patchPersona = (patch) => setDraft((d) => (d ? Object.assign({}, d, patch) : d))
      const patchAppearance = (patch) => setDraft((d) => (d ? Object.assign({}, d, { appearance: Object.assign({}, d.appearance, patch) }) : d))
      const patchPet = (patch) => setDraft((d) => (d ? Object.assign({}, d, { pet: Object.assign({}, d.pet, patch) }) : d))
      const patchNotify = (patch) => setDraft((d) => (d ? Object.assign({}, d, { notify: Object.assign({}, d.notify, patch) }) : d))
      const patchExtensions = (patch) => setDraft((d) => (d ? Object.assign({}, d, { extensions: Object.assign({}, d.extensions, patch) }) : d))
      const patchProactive = (patch) => setDraft((d) => (d ? Object.assign({}, d, { proactive: Object.assign({}, d.proactive, patch) }) : d))
      const setTrait = (key, value) => setDraft((d) => {
        if (!d) return d
        const traits = Object.assign({}, d.traits)
        traits[key] = value
        return Object.assign({}, d, { traits })
      })
      const setTraitScheme = (next) => persistTraitSchemeSwitch(next, {
        draftRef, setDraft, setBusy, setNote, setSnap, draftSig, savedSigRef,
      })
      const setMbtiType = (type) => setDraft((d) => setMbtiTypeOnDraft(d, type))
      const setMbtiAxis = (axis, value) => setDraft((d) => setMbtiAxisOnDraft(d, axis, value))
      const choosePreset = (preset) => setDraft((d) => {
        if (!d) return d
        // 旧预设默认（或空）的自称/称呼跟新预设走；用户自定义值保留。
        const oldP = presets.find((p) => p.id === d.preset)
        const keepCall = d.callUser.trim() && !(oldP && d.callUser.trim() === oldP.defaultCallUser)
        const keepSelf = d.selfRef.trim() && !(oldP && d.selfRef.trim() === oldP.defaultSelfRef)
        return Object.assign({}, d, {
          preset: preset.id,
          callUser: keepCall ? d.callUser : (preset.defaultCallUser || d.callUser),
          selfRef: keepSelf ? d.selfRef : (preset.defaultSelfRef || d.selfRef),
          traits: Object.assign({}, d.traits, preset.traits || {}),
        })
      })

      // Autosave: keep the draft on screen (no flash-reload), debounce edits, and
      // re-queue if the user kept typing while a save was in flight.
      async function save() {
        const current = draftRef.current
        if (!current || savingRef.current) return
        const sig = draftSig(current)
        if (sig === savedSigRef.current) return
        savingRef.current = true
        setBusy(true)
        setNote('保存中…')
        const persona = await api('persona-evolve', buildPersonaEvolvePayload(current))
        let failure = persona && persona.ok === false ? (persona.error || '未知错误') : ''
        let savedName = current.name.trim()
        if (!failure) {
          const appearance = await api('persona-evolve', {
            mode: 'appearance',
            appearance: {
              formPreset: current.appearance.formPreset,
              primaryColor: current.appearance.primaryColor,
              accentColor: current.appearance.accentColor,
              auraColor: current.appearance.auraColor,
              scale: Number(current.appearance.scale),
              accessories: current.appearance.accessories,
              customSpriteUrl: current.appearance.customSpriteUrl,
            },
          })
          if (appearance && appearance.ok === false) failure = appearance.error || '未知错误'
          if (appearance && appearance.displayName) savedName = appearance.displayName
          else if (persona && persona.displayName) savedName = persona.displayName
          // Sprite layer lives outside `appearance` so the static PNG card and the
          // desktop-pet switch never overwrite each other.
          const petSave = await api('config', { pet: current.pet })
          if (petSave && petSave.ok === false) failure = petSave.error || '未知错误'
          if (current.notify) {
            const notifySave = await api('config', { notify: { enabled: current.notify.enabled !== false } })
            if (notifySave && notifySave.ok === false) failure = notifySave.error || '未知错误'
          }
          if (current.extensions) {
            const extSave = await api('config', {
              extensions: {
                biliAutoSurfEnabled: !!current.extensions.biliAutoSurfEnabled,
                biliAutoSurfEveryHours: Number(current.extensions.biliAutoSurfEveryHours) || 6,
                biliAutoSurfEveryMinutes: Number(current.extensions.biliAutoSurfEveryMinutes) || 360,
                biliAutoSurfMaxPick: Number(current.extensions.biliAutoSurfMaxPick) || 2,
                biliAutoSurfDeepWatch: !!current.extensions.biliAutoSurfDeepWatch,
                biliSurfIncludePopular: current.extensions.biliSurfIncludePopular !== false,
                biliSurfSearchOrder: ['totalrank', 'pubdate', 'click'].includes(current.extensions.biliSurfSearchOrder)
                  ? current.extensions.biliSurfSearchOrder
                  : 'totalrank',
                biliSurfDeepJudge: current.extensions.biliSurfDeepJudge !== false,
                biliSurfIncludeArticles: current.extensions.biliSurfIncludeArticles !== false,
                biliLiveFrameWatch: !!current.extensions.biliLiveFrameWatch,
                biliLiveFrameEverySec: Number(current.extensions.biliLiveFrameEverySec) || 15,
                biliFfmpegPath: String(current.extensions.biliFfmpegPath || ''),
                biliVisionSummary: current.extensions.biliVisionSummary !== false,
                biliVisionModel: String(current.extensions.biliVisionModel || ''),
                biliAsrEndpoint: String(current.extensions.biliAsrEndpoint || ''),
                biliAsrApiKey: String(current.extensions.biliAsrApiKey || ''),
                biliAsrModel: String(current.extensions.biliAsrModel || ''),
                biliAsrProtocol: String(current.extensions.biliAsrProtocol || 'deepseek'),
                biliAsrAlways: current.extensions.biliAsrAlways === true,
                biliKeywordsAuto: current.extensions.biliKeywordsAuto !== false,
                biliKeywordsSeed: (current.extensions.biliKeywordsSeed || []).map((k) => String(k).trim()).filter(Boolean),
                biliKeywords: (current.extensions.biliKeywords || []).map((k) => String(k).trim()).filter(Boolean),
                biliAutoEngageEnabled: current.extensions.biliAutoEngageEnabled !== false,
                biliAutoReplyEnabled: current.extensions.biliAutoReplyEnabled !== false,
                biliAutoReplyMaxRounds: Number(current.extensions.biliAutoReplyMaxRounds) || 2,
                biliFollowDedupDays: Number(current.extensions.biliFollowDedupDays) || 7,
                biliCommentMaxChars: Number(current.extensions.biliCommentMaxChars) || 80,
                biliCommentDailyCap: Number.isFinite(Number(current.extensions.biliCommentDailyCap)) ? Number(current.extensions.biliCommentDailyCap) : 5,
                biliLikeDailyCap: Number.isFinite(Number(current.extensions.biliLikeDailyCap)) ? Number(current.extensions.biliLikeDailyCap) : 10,
                biliFavoriteDailyCap: Number.isFinite(Number(current.extensions.biliFavoriteDailyCap)) ? Number(current.extensions.biliFavoriteDailyCap) : 10,
                biliFollowDailyCap: Number.isFinite(Number(current.extensions.biliFollowDailyCap)) ? Number(current.extensions.biliFollowDailyCap) : 2,
                biliCoinEnabled: current.extensions.biliCoinEnabled === true,
                biliCoinDailyCap: Number.isFinite(Number(current.extensions.biliCoinDailyCap)) ? Number(current.extensions.biliCoinDailyCap) : 2,
                biliEngageLlmEnabled: current.extensions.biliEngageLlmEnabled !== false,
                imProactiveEnabled: current.extensions.imProactiveEnabled === true,
                imProactiveWhitelist: Array.isArray(current.extensions.imProactiveWhitelist)
                  ? current.extensions.imProactiveWhitelist.filter((e) => e && typeof e === 'object')
                  : [],
                imProactivePerConvDaily: Number(current.extensions.imProactivePerConvDaily) || 2,
                imProactiveDailyTotal: Number(current.extensions.imProactiveDailyTotal) || 4,
                imProactiveMinGapMinutes: Number(current.extensions.imProactiveMinGapMinutes) || 90,
                imProactiveMaxChars: Number(current.extensions.imProactiveMaxChars) || 120,
                imOwnerWeixin: String(current.extensions.imOwnerWeixin || ''),
                imOwnerQq: String(current.extensions.imOwnerQq || ''),
                imOwnerFeishu: String(current.extensions.imOwnerFeishu || ''),
                imOwnerDingtalk: String(current.extensions.imOwnerDingtalk || ''),
              },
            })
            if (extSave && extSave.ok === false) failure = extSave.error || '未知错误'
          }
          // Proactive scheduler knobs. These are executed by the node half every tick, so
          // the switch the user flips here is the one that actually gates her voice.
          if (current.proactive) {
            const proSave = await api('config', {
              proactive: {
                enabled: current.proactive.enabled !== false,
                dailyDiary: current.proactive.dailyDiary !== false,
                dreamReflect: current.proactive.dreamReflect !== false,
                preferOffPeak: current.proactive.preferOffPeak !== false,
                maxPerDay: Number(current.proactive.maxPerDay),
                dreamLlmEnabled: !!current.proactive.dreamLlmEnabled,
                dreamLlmDailyCap: Number(current.proactive.dreamLlmDailyCap) || 0,
                dreamLlmModel: String(current.proactive.dreamLlmModel || ''),
                distillLlmEnabled: !!current.proactive.distillLlmEnabled,
                distillLlmDailyCap: Number(current.proactive.distillLlmDailyCap) || 0,
                distillLlmModel: String(current.proactive.distillLlmModel || ''),
                intentEnabled: !!current.proactive.intentEnabled,
                intentLlmDailyCap: Number(current.proactive.intentLlmDailyCap) || 0,
                intentLlmModel: String(current.proactive.intentLlmModel || ''),
                intentMaxActsPerDay: Number(current.proactive.intentMaxActsPerDay) || 5,
                experienceEnabled: current.proactive.experienceEnabled !== false,
              },
            })
            if (proSave && proSave.ok === false) failure = proSave.error || '未知错误'
          }
          if (current.chatHome) {
            const homeSave = await api('config', {
              chatHome: {
                autoMemory: current.chatHome.autoMemory !== false,
                bootGreeting: current.chatHome.bootGreeting !== false,
                handoffSeed: current.chatHome.handoffSeed !== false,
                rotateOnPersonaChange: current.chatHome.rotateOnPersonaChange !== false,
                maxTurns: Number(current.chatHome.maxTurns) || 500,
                maxEstTokens: Number(current.chatHome.maxEstTokens) || 72000,
              },
            })
            if (homeSave && homeSave.ok === false) failure = homeSave.error || '未知错误'
          }
        }
        savingRef.current = false
        setBusy(false)
        if (failure) {
          setNote('没保存成功：' + failure)
          return
        }
        savedSigRef.current = sig
        setNote('已自动保存')
        if (typeof onSidebarLabelChange === 'function') onSidebarLabelChange(sidebarLabelOf(savedName))
        api('state').then((data) => { if (data && data.ok !== false) setSnap(data) })
        api('engine').then((eng) => { if (eng && eng.ok !== false) setEngine(eng) })
        if (draftSig(draftRef.current) !== savedSigRef.current) {
          setTimeout(() => { save() }, 120)
        }
      }

      React.useEffect(() => {
        if (!draft) return undefined
        if (draftSig(draft) === savedSigRef.current) return undefined
        const timer = setTimeout(() => { save() }, 700)
        return () => clearTimeout(timer)
      }, [draft])

      const field = (key, label, control) => h('label', { key, className: 'sm-panel-field' }, [
        h('span', { key: 'label' }, label),
        control,
      ])
      // Token 统计: fetch once when the tab opens, and after every save.
      // Declared up here, before the `if (!draft)` early return, on purpose: React requires
      // hooks to run in the same order on every render. A `useCallback` below the early
      // return meant that the very first paint (draft still null) registered one hook fewer
      // than the next one, which desynchronises the hook list and blanks the whole settings
      // page. Both setters are stable, so keeping the callback above costs nothing.
      const loadUsage = React.useCallback(async () => {
        const res = await api('usage')
        if (res && res.ok !== false) {
          setUsage(res)
          setUsageDraft({
            dailyAutoTokenCap: res.config ? res.config.dailyAutoTokenCap : 2000000,
            onCapReached: (res.config && res.config.onCapReached) || 'block',
          })
        }
      }, [])

      React.useEffect(() => {
        if ((tab === 'usage' || tab === 'rhythm') && !usage) loadUsage()
      }, [tab, usage, loadUsage])

      React.useEffect(() => {
        if (tab !== 'diary') return undefined
        let alive = true
        const loadShelf = () => {
          api('bookshelf').then((res) => {
            if (!alive || !res || res.ok === false) return
            setShelf(res)
          })
        }
        loadShelf()
        const timer = setInterval(loadShelf, 20000)
        return () => { alive = false; clearInterval(timer) }
      }, [tab])

      if (!draft) {
        return h('div', { className: 'sm-panel' }, h('div', { className: 'sm-panel-wrap' }, h('div', { key: 'state', className: 'sm-panel-card' }, [
          h('h3', { key: 'h', className: 'sm-panel-h3' }, error ? '连不上小伙伴' : '正在读取……'),
          error ? h('p', { key: 'p', className: 'sm-panel-muted' }, error) : null,
          error ? h('button', { key: 'retry', type: 'button', className: 'sm-panel-btn', onClick: load }, '重试') : null,
        ])))
      }

      const stage = (snap && snap.bondStage) || {}
      const state = (snap && snap.state) || {}
      const presets = (snap && snap.presets && snap.presets.length ? snap.presets : PRESET_FALLBACK)
      const effective = (engine && engine.persona && engine.persona.effectiveTraits) || (snap && snap.effectiveTraits) || {}
      const st = (engine && engine.status) || {}
      const rel = st.relationship || {}
      const mem = st.memory || {}
      const time = st.time || {}
      const budget = st.contextBudget || {}
      const strategy = (engine && engine.scheduling && engine.scheduling.strategy) || {}
      const inv = (engine && engine.persona && engine.persona.invariants) || { values: [], boundaries: [] }
      const changelog = (engine && engine.persona && engine.persona.changelog) || []
      const pending = (engine && engine.persona && engine.persona.candidatesPending) || 0
      const spriteUrl = draft.appearance.customSpriteUrl && String(draft.appearance.customSpriteUrl).trim()
      // 头部头像跟随桌宠皮肤:上传图优先,否则用皮肤静帧,
      // 换皮肤后「设置」头部不再停在旧图。
      const headSkin = (draft.pet && draft.pet.skin) || ''
      const headSrc = (draft.appearance.spriteIsUpload && spriteUrl)
        ? spriteUrl
        : (headSkin ? skinFrameUrl(headSkin, skinList) : (spriteUrl || ''))
      const selfText = (engine && engine.persona && engine.persona.selfSummary) || ''
      const hasSelf = Boolean(selfText) && !selfText.includes('尚未填写')

      const head = h('div', { key: 'head', className: 'sm-panel-head' }, [
        headSrc
          ? h('img', { key: 'sprite', className: 'sm-sprite', src: headSrc, alt: '精灵贴图' })
          : h('canvas', { key: 'avatar', ref: canvasRef, className: 'sm-panel-avatar', width: 176, height: 176 }),
        h('div', { key: 'meta', className: 'sm-panel-id' }, [
          h('h2', { key: 'title', className: 'sm-panel-title' }, (snap && snap.displayName ? snap.displayName : 'soulmate') + ' 的设置'),
          h('div', { key: 'readout', className: 'sm-id-readout' }, [
            h('span', { key: 'lv' }, ['等级', h('b', null, String(stage.level || 1))]),
            h('span', { key: 'stage' }, ['阶段', h('b', null, stage.title || '初遇室友')]),
            h('span', { key: 'aff' }, ['亲密度', h('b', null, String(Number(state.affinity) || 0))]),
            h('span', { key: 'mood' }, ['心情', h('b', null, ({
              happy: '开心', content: '满足', calm: '平静', sleepy: '困倦', hungry: '饿了',
              sad: '有点失落', excited: '兴奋', grumpy: '别扭', neutral: '平常',
            })[state.mood] || state.mood || '平常')]),
          ]),
          null,
        ]),
        h(UpdateBadge, { key: 'update' }),
      ])

      // The three passive cards live in panel-cards.mjs; this page only hands them the
      // slices it already derived from the engine snapshot.
      const statusCardEl = statusCard({ rel, st, state, stage, mem, time, budget, pending })
      const schedulingCardEl = schedulingCard(strategy)
      const personaCardEl = personaCard({ inv, changelog, selfText, hasSelf })

      const activePreset = presets.find((p) => p.id === draft.preset) || presets[0] || null
      // Gender switch confirms then hits persona-evolve directly (blank fallback + appearance on node).
      async function switchGender(nextGender, preset) {
        if (nextGender !== 'male' && nextGender !== 'female') return
        if (draft.gender === nextGender && !(preset && preset.id && preset.id !== draft.preset)) {
          if (preset) choosePreset(preset)
          return
        }
        const label = preset && (preset.name || preset.id)
        const msg = label
          ? '切换到该性别并选用「' + label + '」？性格目录与默认形象会跟着变（自定义立绘保留）。'
          : '切换伙伴性别？性格目录与默认形象会跟着变（自定义立绘保留）。'
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(msg)) return
        setBusy(true)
        setNote('切换性别…')
        const payload = { mode: 'user_customize', gender: nextGender }
        if (preset && preset.id) payload.preset = preset.id
        const res = await api('persona-evolve', payload)
        if (res && res.ok === false) {
          setNote('切换失败：' + (res.error || '未知错误'))
          setBusy(false)
          return
        }
        const data = await api('state')
        if (data && data.ok !== false) {
          setSnap(data)
          const next = draftFromSummary(data)
          savedSigRef.current = draftSig(next)
          setDraft(next)
        }
        const eng = await api('engine')
        if (eng && eng.ok !== false) setEngine(eng)
        setNote('已切换性别')
        setBusy(false)
      }
      // The editable forms live in panel-forms.mjs; the page only supplies state + callbacks.
      const identity = identityCard({ draft, presets, activePreset, patchPersona, choosePreset, switchGender })
      const gateBudget = (engine && engine.persona && engine.persona.weeklyBudget) || null
      const gateCard = gateCardEl({
        gateBudget, pending, traitScheme: draft.traitScheme,
        gender: draft.gender === 'male' || draft.gender === 'female' ? draft.gender : null,
      })
      const traits = traitsCard(traitsCardInputs({
        draft, effective, setTrait, setTraitScheme, setMbtiType, setMbtiAxis,
        quizBusy, setQuizBusy, quizMsg, setQuizMsg, quizMsgKind, setQuizMsgKind, snap,
      }))

      async function restoreDefaultSprite() {
        setSpriteNote('恢复默认…')
        try {
          const url = await deleteSprite(draft.gender)
          const fallback = draft.gender === 'male' ? DEFAULT_SPRITE_MALE_URL : DEFAULT_SPRITE_URL
          patchAppearance({ customSpriteUrl: url || fallback, spriteIsUpload: false })
          patchPet({ skin: draft.gender === 'male' ? 'winterboy-chibi' : 'hanfu', skinAuto: true })
          setSpriteNote('已恢复默认 · Q版形象')
        } catch (err) {
          setSpriteNote('恢复失败：' + (err && err.message ? err.message : String(err)))
        }
      }

      async function selectBundledLook(look) {
        if (!look || !look.id) return
        if (skinBusy) return
        setSkinBusy(true)
        setSpriteNote('切换形象…')
        try {
          if (look.downloadable && look.installed === false) {
            setSpriteNote('首次使用，正在从 GitHub Release 下载皮肤包…')
            const installed = await api('pet/skins/install', { id: look.id })
            if (!installed || installed.ok === false) {
              throw new Error((installed && installed.error) || '皮肤包下载失败')
            }
            const catalog = await api('pet/skins')
            if (catalog && catalog.ok !== false && Array.isArray(catalog.skins) && catalog.skins.length) {
              setSkinList(catalog.skins)
            }
          }
          // Drop uploaded sticker so the bundled frame shows through.
          try { await deleteSprite(draft.gender) } catch (_) { /* ignore */ }
          const url = String(look.preview || '') + (String(look.preview || '').includes('?') ? '&' : '?') + 'v=' + Date.now()
          patchAppearance({ customSpriteUrl: url, spriteIsUpload: false })
          patchPet({ skin: look.id, skinAuto: false })
          setSpriteNote('已切换：' + (look.label || look.id) + '（桌宠皮肤已同步）')
        } catch (err) {
          setSpriteNote('切换失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setSkinBusy(false)
        }
      }

      // Dynamic layer card: sits under the static PNG card, never replaces it.
      const petDraft = draft.pet || { enabled: false, sizePx: 148, sleepAfterIdleSec: 300, skin: 'winterboy-chibi', skinAuto: true }
      const lookPetCardEl = lookPetCard({
        draft, petDraft, patchPet, spriteNote, restoreDefaultSprite,
        selectBundledLook,
        looks: skinList,
        skinBusy,
        PetPreview,
        windowStatus: snap && snap.petWindow,
        defaultSpriteUrl: draft.gender === 'male' ? DEFAULT_SPRITE_MALE_URL : DEFAULT_SPRITE_URL,
      })

      // Proactive scheduler draft: the rhythm tab binds to this mirror of config.
      const proDraft = draft.proactive || {
        enabled: true, dailyDiary: true, dreamReflect: true, preferOffPeak: true, maxPerDay: 3, quietHours: [],
      }
      const homeDraft = draft.chatHome || {
        autoMemory: true, bootGreeting: true, handoffSeed: true, maxTurns: 500, maxEstTokens: 72000, titlePrefix: '',
      }
      const patchChatHome = (patch) => setDraft((d) => (d ? Object.assign({}, d, { chatHome: Object.assign({}, d.chatHome, patch) }) : d))
      const homeLive = proStatus && proStatus.chatHome
      const homeCfg = (homeLive && homeLive.chatHome) || homeDraft
      const rhythmCard = rhythmCardEl({
        draft, proDraft, homeDraft, patchProactive, patchChatHome, patchNotify,
        proStatus, homeCfg, homeFull: homeLive && homeLive.fullness,
        homeMeasure: homeLive && homeLive.measure, snap, usage,
        llmBudgetSection,
      })
      // Must pass as component to h() — surfCard uses useState/useEffect. Calling it as a
      // plain function after the empty-draft early return changes hook order and blanks the panel.
      const surfPage = h(surfCardEl, { key: 'surf-page', draft, patchExtensions })

      const neuronCard = h(NeuronCard, { key: 'neurons', mem, onNote: setNote })

      const tabs = [
        { id: 'surf', label: '冲浪', feature: true },
        { id: 'dsbot', label: 'DsBot', feature: true },
        { id: 'identity', label: '称呼与形象', feature: true },
        { id: 'status', label: '状态总览' },
        { id: 'personality', label: '性格观察与设置' },
        { id: 'neurons', label: '记忆神经网络' },
        { id: 'rhythm', label: '作息与主动' },
        { id: 'usage', label: '用量统计' },
        { id: 'diary', label: '日记' },
      ]
      const tabBar = h('div', { key: 'tabs', className: 'sm-tabs', role: 'tablist' }, tabs.map((item) => h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === item.id ? 'true' : 'false',
        className: 'sm-tab'
          + (item.feature ? ' sm-tab-feature' : '')
          + (tab === item.id ? ' on' : ''),
        onClick: () => setTab(item.id),
      }, item.label)))

      async function trustAct(path, body) {
        setBusy(true)
        setNote('处理中…')
        const res = await api(path, body)
        setBusy(false)
        setNote(res && res.ok ? '好，记下了。' : (res && res.error) || '没改成')
        const eng = await api('engine')
        if (eng && eng.ok !== false) setEngine(eng)
      }

      async function saveUsage() {
        if (usageBusy) return
        setUsageBusy(true)
        setUsageNote('保存中…')
        const res = await api('usage', usageDraft || {})
        setUsageBusy(false)
        if (res && res.ok) {
          setUsageNote('已保存')
          await loadUsage()
        } else {
          setUsageNote((res && res.error) || '没保存成功')
        }
      }

      const panels = {
        status: [statusCardEl, schedulingCardEl, trustCard({
          trust: (engine && engine.trust) || { promises: [], conflicts: [] },
          presence: (engine && engine.presence) || { text: '' },
          trustAct,
        })],
        personality: [personaCardEl, traits, gateCard],
        neurons: [neuronCard],
        identity: [identity, lookPetCardEl, h(SoulShareCard, { key: 'soul-share', onImported: load })],
        rhythm: [rhythmCard],
        surf: [surfPage],
        usage: [usageCard({ usage, draft: usageDraft, busy: usageBusy, note: usageNote, h, onDraft: (patch) => setUsageDraft((prev) => ({ ...(prev || {}), ...patch })), onSave: saveUsage })],
        diary: [diaryCard({
          shelf,
          book: diaryBook,
          selectedId: diaryId,
          onBook: (next) => { setDiaryBook(next); setDiaryId(null) },
          onSelect: setDiaryId,
          gender: draft.gender === 'male' || draft.gender === 'female' ? draft.gender : null,
          h,
        })],
        dsbot: [h(DsBotCard, { key: 'dsbot', ext: draft.extensions || {}, patchExtensions })],
      }

      return h('div', { className: 'sm-panel' }, h('div', { className: 'sm-panel-wrap' }, [
        head, tabBar, ...(panels[tab] || panels.status),
      ]))
    }

function setLabelChangeHook(fn) { onSidebarLabelChange = typeof fn === 'function' ? fn : null }
function notifyLabelChange(name) { if (onSidebarLabelChange) onSidebarLabelChange(name) }

module.exports = { PANEL_ID, PANEL_ORDER, sidebarLabelOf, setLabelChangeHook, notifyLabelChange, SoulmatePanelIcon, SoulmatePanelPage, draftFromSummary }
