// Project the node half's `/api/state` payload onto the editable draft the settings
// page binds to. Pure data mapping — deliberately free of React so it can be tested
// and reused without a component tree.
const { clampNum } = require('./util.mjs')

const TRAIT_LABELS = {
  tsundere: ['傲娇度', '嘴硬心软：越高越爱逞强、嘴上不饶人，心里其实在意你。'],
  clinginess: ['粘人度', '独立 ⇄ 撒娇：越高越爱黏着你、怕被冷落；偏低更自立。'],
  sassiness: ['毒舌度', '温柔 ⇄ 犀利：越高吐槽越尖；偏低说话更软、更哄。'],
  curiosity: ['好奇心', '爱问东问西：越高越爱追问细节、主动探新；偏低更佛系。'],
  brevity: ['简洁度', '细节控 ⇄ 短句：越高越爱短答；偏低更爱展开说明。'],
}
const TRAIT_FALLBACK = { tsundere: 75, clinginess: 60, sassiness: 55, curiosity: 70, brevity: 65 }
const DEFAULT_SPRITE_URL = '/dsh-soulmate/api/sprite'
const DEFAULT_SPRITE_MALE_URL = '/dsh-soulmate/api/sprite-male'

const MBTI_TYPES = Object.freeze([
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
])

const MBTI_AXES = Object.freeze(['EI', 'SN', 'TF', 'JP'])

const MBTI_AXIS_LABELS = Object.freeze({
  EI: ['外向 E', '内向 I'],
  SN: ['感觉 S', '直觉 N'],
  TF: ['思考 T', '情感 F'],
  JP: ['判断 J', '感知 P'],
})

const MBTI_BLURBS = Object.freeze({
  INTJ: '远见策士：先结构后动手，话少但准，讨厌无效社交与情绪表演。',
  INTP: '逻辑拆解者：先问为什么，嘴上淡、爱补丁和例外，讨厌被催结论。',
  ENTJ: '果断指挥官：结论先行、推进力强，会直接派活，偶尔显得强势。',
  ENTP: '火花辩手：点子多、爱抬杠，把无聊话题玩出岔路，讨厌一本正经念经。',
  INFJ: '深海守望：共情细、记得住心事，说话留余地，不爱当众拆台。',
  INFP: '温柔理想派：重感受与意义，黏而不闹，讨厌被逼着站队吵架。',
  ENFJ: '暖场领航：先照顾气氛再推进，主动关心，说话有感染力。',
  ENFP: '热络探索者：好奇拉满、黏人爱聊，讨厌冷场和一句「随便」。',
  ISTJ: '靠谱执行：规则清晰、话短有数，承诺了就做，讨厌临时改计划。',
  ISFJ: '细心守护：默默记习惯，温柔提醒，不抢戏，讨厌被当透明人。',
  ESTJ: '务实组织者：效率优先，直接给方案和截止时间，少抒情。',
  ESFJ: '热心协调：在意你舒不舒服，爱张罗、爱回消息，讨厌被晾着。',
  ISTP: '冷静动手派：少说多做，修东西一流，保持距离感，讨厌空谈。',
  ISFP: '安静审美：感受力强、口吻软，不爱争对错，讨厌被逼表态。',
  ESTP: '当下行动派：干脆利落，爱现场解决，讨厌长篇铺垫。',
  ESFP: '气氛担当：活泼外放，爱互动，把沉闷聊开，讨厌说教。',
})

/** Mirror of soulmate-core/mbti.mjs defaults — keep in sync for snappy UI before autosave. */
const MBTI_TRAIT_DEFAULTS = Object.freeze({
  INTJ: { tsundere: 62, clinginess: 18, sassiness: 68, curiosity: 78, brevity: 88 },
  INTP: { tsundere: 38, clinginess: 22, sassiness: 58, curiosity: 94, brevity: 48 },
  ENTJ: { tsundere: 48, clinginess: 28, sassiness: 78, curiosity: 72, brevity: 90 },
  ENTP: { tsundere: 52, clinginess: 48, sassiness: 92, curiosity: 94, brevity: 32 },
  INFJ: { tsundere: 22, clinginess: 78, sassiness: 18, curiosity: 74, brevity: 46 },
  INFP: { tsundere: 12, clinginess: 82, sassiness: 8, curiosity: 68, brevity: 42 },
  ENFJ: { tsundere: 16, clinginess: 88, sassiness: 28, curiosity: 74, brevity: 36 },
  ENFP: { tsundere: 20, clinginess: 92, sassiness: 42, curiosity: 95, brevity: 22 },
  ISTJ: { tsundere: 32, clinginess: 18, sassiness: 28, curiosity: 38, brevity: 92 },
  ISFJ: { tsundere: 14, clinginess: 78, sassiness: 12, curiosity: 42, brevity: 58 },
  ESTJ: { tsundere: 42, clinginess: 32, sassiness: 62, curiosity: 44, brevity: 92 },
  ESFJ: { tsundere: 18, clinginess: 88, sassiness: 22, curiosity: 52, brevity: 42 },
  ISTP: { tsundere: 48, clinginess: 12, sassiness: 55, curiosity: 68, brevity: 88 },
  ISFP: { tsundere: 16, clinginess: 58, sassiness: 14, curiosity: 62, brevity: 52 },
  ESTP: { tsundere: 42, clinginess: 42, sassiness: 72, curiosity: 72, brevity: 78 },
  ESFP: { tsundere: 28, clinginess: 82, sassiness: 48, curiosity: 74, brevity: 28 },
})

function clamp01(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
}

function normalizeMbtiType(type) {
  const t = String(type || '').trim().toUpperCase()
  return MBTI_TYPES.includes(t) ? t : 'INFP'
}

function defaultAxesForType(type) {
  const t = normalizeMbtiType(type)
  const center = (letter, left, right) => (letter === left ? 22 : letter === right ? 78 : 50)
  return {
    EI: center(t[0], 'E', 'I'),
    SN: center(t[1], 'S', 'N'),
    TF: center(t[2], 'T', 'F'),
    JP: center(t[3], 'J', 'P'),
  }
}

function normalizeMbtiAxes(raw, type) {
  const base = defaultAxesForType(type)
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const axis of MBTI_AXES) out[axis] = clamp01(src[axis] != null ? src[axis] : base[axis])
  return out
}

function typeFromAxes(axes) {
  const a = normalizeMbtiAxes(axes, 'INFP')
  const pick = (axis, left, right) => (a[axis] >= 50 ? right : left)
  return pick('EI', 'E', 'I') + pick('SN', 'S', 'N') + pick('TF', 'T', 'F') + pick('JP', 'J', 'P')
}

function mbtiToTraits(type, axes) {
  const t = normalizeMbtiType(type)
  const base = Object.assign({}, MBTI_TRAIT_DEFAULTS[t] || MBTI_TRAIT_DEFAULTS.INFP)
  const a = normalizeMbtiAxes(axes, t)
  const home = defaultAxesForType(t)
  const d = (axis) => (a[axis] - home[axis]) / 50
  const bump = (key, amount) => { base[key] = clamp01(base[key] + amount) }
  bump('clinginess', -d('EI') * 18 + (a.EI < 50 ? 12 : -8))
  bump('tsundere', d('EI') * 10)
  bump('brevity', d('EI') * 6)
  bump('curiosity', d('SN') * 18)
  bump('brevity', -d('SN') * 12)
  bump('clinginess', d('TF') * 14)
  bump('sassiness', -d('TF') * 16)
  bump('tsundere', -d('TF') * 6)
  bump('brevity', -d('JP') * 14)
  bump('curiosity', d('JP') * 8)
  bump('sassiness', d('JP') * 4)
  return base
}

function normalizeMbtiBlock(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const type = normalizeMbtiType(src.type)
  const axes = normalizeMbtiAxes(src.axes, type)
  return { type: typeFromAxes(axes), axes }
}

function draftFromSummary(snap) {
  const config = (snap && snap.config) || {}
  const persona = config.persona || {}
  const appearance = config.appearance || {}
  const traits = {}
  for (const key of Object.keys(TRAIT_LABELS)) {
    const value = Number(persona.traits && persona.traits[key])
    traits[key] = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : TRAIT_FALLBACK[key]
  }
  const scale = Number(appearance.scale)
  const mbti = normalizeMbtiBlock(persona.mbti)
  const traitScheme = persona.traitScheme === 'mbti' ? 'mbti' : 'five'
  const gender = persona.gender === 'male' || persona.gender === 'female' ? persona.gender : null
  return {
    name: typeof persona.name === 'string' ? persona.name : '',
    callUser: typeof persona.callUser === 'string' ? persona.callUser : '',
    selfRef: typeof persona.selfRef === 'string' ? persona.selfRef : '',
    city: typeof persona.city === 'string' ? persona.city : '',
    customBody: typeof persona.customBody === 'string' ? persona.customBody : '',
    gender,
    preset: typeof persona.preset === 'string' ? persona.preset : 'rice-whale',
    traitScheme,
    traits,
    mbti,
    schemeSnapshots: {
      five: persona.schemeSnapshots && persona.schemeSnapshots.five
        ? { traits: persona.schemeSnapshots.five.traits ? Object.assign({}, persona.schemeSnapshots.five.traits) : null }
        : { traits: null },
      mbti: persona.schemeSnapshots && persona.schemeSnapshots.mbti && persona.schemeSnapshots.mbti.type
        ? {
          type: persona.schemeSnapshots.mbti.type,
          axes: Object.assign({}, persona.schemeSnapshots.mbti.axes || {}),
        }
        : null,
    },
    appearance: {
      formPreset: appearance.formPreset || 'whale-girl',
      primaryColor: appearance.primaryColor || '#4176e6',
      accentColor: appearance.accentColor || '#7aaaff',
      auraColor: appearance.auraColor || '#e4edfd',
      scale: Number.isFinite(scale) ? scale : 1,
      accessories: Object.assign({ ironBowl: false, holoHeadset: false, quantumHalo: false, starRing: false }, appearance.accessories || {}),
      customSpriteUrl: (typeof appearance.customSpriteUrl === 'string' && appearance.customSpriteUrl.trim())
        ? appearance.customSpriteUrl.trim()
        : DEFAULT_SPRITE_URL,
    },
    pet: {
      enabled: !!(config.pet && config.pet.enabled),
      sizePx: clampNum(Number(config.pet && config.pet.sizePx) || 148, 96, 320),
      sleepAfterIdleSec: clampNum(Number(config.pet && config.pet.sleepAfterIdleSec) || 300, 30, 3600),
      thinkQuietSec: (Number.isFinite(Number(config.pet && config.pet.thinkQuietSec)) ? Number(config.pet.thinkQuietSec) : 1.5),
      skin: (config.pet && typeof config.pet.skin === 'string' && config.pet.skin.trim())
        ? config.pet.skin.trim()
        : ((config.persona && config.persona.gender === 'male') ? 'winterboy-chibi' : 'hanfu'),
      skinAuto: !(config.pet && config.pet.skinAuto === false),
      // Window form + physics + idle walk: keep every pet key in the draft, otherwise the
      // switch appears to flip back after any reload/autosave round-trip.
      windowEnabled: !!(config.pet && config.pet.windowEnabled),
      windowElectronPath: (config.pet && typeof config.pet.windowElectronPath === 'string') ? config.pet.windowElectronPath : '',
      physics: {
        gravity: (Number.isFinite(Number(config.pet && config.pet.physics && config.pet.physics.gravity)) ? Number(config.pet.physics.gravity) : 1400),
        restitution: (Number.isFinite(Number(config.pet && config.pet.physics && config.pet.physics.restitution)) ? Number(config.pet.physics.restitution) : 0.78),
        groundFriction: (Number.isFinite(Number(config.pet && config.pet.physics && config.pet.physics.groundFriction)) ? Number(config.pet.physics.groundFriction) : 2.5),
        throwPower: (Number.isFinite(Number(config.pet && config.pet.physics && config.pet.physics.throwPower)) ? Number(config.pet.physics.throwPower) : 1),
      },
      ambientWalk: !(config.pet && config.pet.ambientWalk === false),
      ambientWalkAfterSec: (Number.isFinite(Number(config.pet && config.pet.ambientWalkAfterSec)) ? Number(config.pet.ambientWalkAfterSec) : 15),
      ambientWalkChance: (Number.isFinite(Number(config.pet && config.pet.ambientWalkChance)) ? Number(config.pet.ambientWalkChance) : 0.35),
    },
    notify: { enabled: !(config.notify && config.notify.enabled === false) },
    extensions: {
      biliEnabled: !(config.extensions && config.extensions.biliEnabled === false),
      biliAutoSurfEnabled: !!(config.extensions && config.extensions.biliAutoSurfEnabled),
      biliAutoSurfEveryHours: Number(config.extensions && config.extensions.biliAutoSurfEveryHours) || 6,
      biliAutoSurfEveryMinutes: (() => {
        const {
          resolveSurfIntervalMinutes,
        } = require('./surf-schedule.mjs')
        return resolveSurfIntervalMinutes(config.extensions || {})
      })(),
      biliAutoSurfMaxPick: (() => {
        const {
          clampSurfMaxPick,
          resolveSurfIntervalMinutes,
        } = require('./surf-schedule.mjs')
        const mins = resolveSurfIntervalMinutes(config.extensions || {})
        return clampSurfMaxPick(config.extensions && config.extensions.biliAutoSurfMaxPick, mins)
      })(),
      biliAutoSurfDeepWatch: !!(config.extensions && config.extensions.biliAutoSurfDeepWatch),
      biliSurfIncludePopular: !(config.extensions && config.extensions.biliSurfIncludePopular === false),
      biliSurfSearchOrder: ['totalrank', 'pubdate', 'click'].includes(config.extensions && config.extensions.biliSurfSearchOrder)
        ? config.extensions.biliSurfSearchOrder
        : 'totalrank',
      biliSurfDeepJudge: !(config.extensions && config.extensions.biliSurfDeepJudge === false),
      biliSurfIncludeArticles: !(config.extensions && config.extensions.biliSurfIncludeArticles === false),
      biliLiveFrameWatch: !!(config.extensions && config.extensions.biliLiveFrameWatch),
      biliLiveFrameEverySec: (() => {
        const presets = [15, 20, 30, 45, 60, 90, 120]
        const cur = Number(config.extensions && config.extensions.biliLiveFrameEverySec) || 30
        let best = 30
        let bestDiff = Infinity
        for (const p of presets) {
          const d = Math.abs(p - cur)
          if (d < bestDiff) { best = p; bestDiff = d }
        }
        return best
      })(),
      biliFfmpegPath: (config.extensions && config.extensions.biliFfmpegPath) || '',
      biliVisionSummary: !(config.extensions && config.extensions.biliVisionSummary === false),
      biliVisionModel: (config.extensions && config.extensions.biliVisionModel) || '',
      biliAsrEndpoint: (config.extensions && config.extensions.biliAsrEndpoint) || '',
      biliAsrApiKey: (config.extensions && config.extensions.biliAsrApiKey) || '',
      biliAsrModel: (config.extensions && config.extensions.biliAsrModel) || '',
      biliAsrProtocol: (config.extensions && config.extensions.biliAsrProtocol) || 'deepseek',
      biliAsrAlways: !!(config.extensions && config.extensions.biliAsrAlways === true),
      biliKeywordsAuto: !(config.extensions && config.extensions.biliKeywordsAuto === false),
      biliKeywordsSeed: (config.extensions && Array.isArray(config.extensions.biliKeywordsSeed))
        ? config.extensions.biliKeywordsSeed.slice()
        : [],
      biliKeywordsUpdatedAt: (config.extensions && config.extensions.biliKeywordsUpdatedAt) || '',
      biliKeywords: (config.extensions && Array.isArray(config.extensions.biliKeywords) && config.extensions.biliKeywords.length)
        ? config.extensions.biliKeywords.slice()
        : ['AI', '编程', '科技'],
      biliAutoEngageEnabled: !(config.extensions && config.extensions.biliAutoEngageEnabled === false),
      biliAutoReplyEnabled: !(config.extensions && config.extensions.biliAutoReplyEnabled === false),
      biliAutoReplyMaxRounds: clampNum(Number(config.extensions && config.extensions.biliAutoReplyMaxRounds) || 2, 1, 5),
      biliFollowDedupDays: clampNum(Number(config.extensions && config.extensions.biliFollowDedupDays) || 7, 1, 30),
      biliCommentMaxChars: clampNum(Number(config.extensions && config.extensions.biliCommentMaxChars) || 80, 10, 500),
      biliCommentDailyCap: clampNum(Number.isFinite(Number(config.extensions && config.extensions.biliCommentDailyCap)) ? Number(config.extensions.biliCommentDailyCap) : 5, 0, 30),
      biliLikeDailyCap: clampNum(Number.isFinite(Number(config.extensions && config.extensions.biliLikeDailyCap)) ? Number(config.extensions.biliLikeDailyCap) : 10, 0, 50),
      biliFavoriteDailyCap: clampNum(Number.isFinite(Number(config.extensions && config.extensions.biliFavoriteDailyCap)) ? Number(config.extensions.biliFavoriteDailyCap) : 10, 0, 50),
      biliFollowDailyCap: clampNum(Number.isFinite(Number(config.extensions && config.extensions.biliFollowDailyCap)) ? Number(config.extensions.biliFollowDailyCap) : 2, 0, 20),
      biliCoinEnabled: !!(config.extensions && config.extensions.biliCoinEnabled),
      biliCoinDailyCap: clampNum(Number.isFinite(Number(config.extensions && config.extensions.biliCoinDailyCap)) ? Number(config.extensions.biliCoinDailyCap) : 2, 0, 10),
      biliEngageLlmEnabled: !(config.extensions && config.extensions.biliEngageLlmEnabled === false),
      imProactiveEnabled: !!(config.extensions && config.extensions.imProactiveEnabled),
      imProactiveWhitelist: (config.extensions && Array.isArray(config.extensions.imProactiveWhitelist))
        ? config.extensions.imProactiveWhitelist.filter((e) => e && typeof e === 'object').map((e) => Object.assign({}, e))
        : [],
      imProactivePerConvDaily: clampNum(Number(config.extensions && config.extensions.imProactivePerConvDaily) || 2, 1, 10),
      imProactiveDailyTotal: clampNum(Number(config.extensions && config.extensions.imProactiveDailyTotal) || 4, 1, 20),
      imProactiveMinGapMinutes: clampNum(Number(config.extensions && config.extensions.imProactiveMinGapMinutes) || 90, 10, 720),
      imProactiveMaxChars: clampNum(Number(config.extensions && config.extensions.imProactiveMaxChars) || 120, 10, 500),
      imOwnerWeixin: String((config.extensions && config.extensions.imOwnerWeixin) || ''),
      imOwnerQq: String((config.extensions && config.extensions.imOwnerQq) || ''),
      imOwnerFeishu: String((config.extensions && config.extensions.imOwnerFeishu) || ''),
      imOwnerDingtalk: String((config.extensions && config.extensions.imOwnerDingtalk) || ''),
    },
    // Proactive scheduler: mirrored straight from config so the switches show what the
    // node half is actually running with, not a separate front-end-only copy.
    proactive: {
      enabled: !(config.proactive && config.proactive.enabled === false),
      dailyDiary: !(config.proactive && config.proactive.dailyDiary === false),
      dreamReflect: !(config.proactive && config.proactive.dreamReflect === false),
      preferOffPeak: !(config.proactive && config.proactive.preferOffPeak === false),
      maxPerDay: clampNum(Number(config.proactive && config.proactive.maxPerDay) || 3, 0, 8),
      quietHours: (config.proactive && Array.isArray(config.proactive.quietHours)) ? config.proactive.quietHours.slice() : [],
      dreamLlmEnabled: !!(config.proactive && config.proactive.dreamLlmEnabled),
      dreamLlmDailyCap: clampNum(Number(config.proactive && config.proactive.dreamLlmDailyCap) || 300000, 0, 50_000_000),
      dreamLlmModel: (config.proactive && typeof config.proactive.dreamLlmModel === 'string') ? config.proactive.dreamLlmModel : '',
      distillLlmEnabled: !!(config.proactive && config.proactive.distillLlmEnabled),
      distillLlmDailyCap: clampNum(Number(config.proactive && config.proactive.distillLlmDailyCap) || 200000, 0, 50_000_000),
      distillLlmModel: (config.proactive && typeof config.proactive.distillLlmModel === 'string') ? config.proactive.distillLlmModel : '',
      intentEnabled: !!(config.proactive && config.proactive.intentEnabled),
      intentLlmDailyCap: clampNum(Number(config.proactive && config.proactive.intentLlmDailyCap) || 60000, 0, 50_000_000),
      intentLlmModel: (config.proactive && typeof config.proactive.intentLlmModel === 'string') ? config.proactive.intentLlmModel : '',
      intentMaxActsPerDay: clampNum(Number(config.proactive && config.proactive.intentMaxActsPerDay) || 3, 1, 8),
      experienceEnabled: !(config.proactive && config.proactive.experienceEnabled === false),
    },
    chatHome: {
      autoMemory: !(config.chatHome && config.chatHome.autoMemory === false),
      bootGreeting: !(config.chatHome && config.chatHome.bootGreeting === false),
      handoffSeed: !(config.chatHome && config.chatHome.handoffSeed === false),
      rotateOnPersonaChange: !(config.chatHome && config.chatHome.rotateOnPersonaChange === false),
      maxTurns: clampNum(Number(config.chatHome && config.chatHome.maxTurns) || 500, 10, 500),
      maxEstTokens: clampNum(Number(config.chatHome && config.chatHome.maxEstTokens) || 72000, 5000, 500000),
      titlePrefix: (config.chatHome && typeof config.chatHome.titlePrefix === 'string' && config.chatHome.titlePrefix.trim())
        ? config.chatHome.titlePrefix.trim()
        : 'soulmate',
      activeSessionId: (config.chatHome && config.chatHome.activeSessionId) || '',
      archiveSessionIds: (config.chatHome && Array.isArray(config.chatHome.archiveSessionIds))
        ? config.chatHome.archiveSessionIds.slice()
        : [],
    },
  }
}

/** Stable signature used by autosave to detect "nothing actually changed". */
function draftSignature(draft) {
  if (!draft) return ''
  return JSON.stringify({
    name: draft.name, callUser: draft.callUser, selfRef: draft.selfRef, city: draft.city, customBody: draft.customBody,
    gender: draft.gender, preset: draft.preset, traitScheme: draft.traitScheme, traits: draft.traits, mbti: draft.mbti,
    appearance: draft.appearance, pet: draft.pet, notify: draft.notify, extensions: draft.extensions,
    proactive: draft.proactive,
    chatHome: draft.chatHome && {
      autoMemory: draft.chatHome.autoMemory,
      bootGreeting: draft.chatHome.bootGreeting,
      handoffSeed: draft.chatHome.handoffSeed,
      rotateOnPersonaChange: draft.chatHome.rotateOnPersonaChange,
      maxTurns: draft.chatHome.maxTurns,
      maxEstTokens: draft.chatHome.maxEstTokens,
      titlePrefix: draft.chatHome.titlePrefix,
    },
  })
}

module.exports = {
  TRAIT_LABELS,
  TRAIT_FALLBACK,
  DEFAULT_SPRITE_URL,
  DEFAULT_SPRITE_MALE_URL,
  MBTI_TYPES,
  MBTI_AXES,
  MBTI_AXIS_LABELS,
  MBTI_BLURBS,
  MBTI_TRAIT_DEFAULTS,
  draftFromSummary,
  draftSignature,
  normalizeMbtiType,
  defaultAxesForType,
  normalizeMbtiAxes,
  typeFromAxes,
  mbtiToTraits,
  normalizeMbtiBlock,
}
