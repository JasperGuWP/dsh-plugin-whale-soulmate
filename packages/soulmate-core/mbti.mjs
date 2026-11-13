/**
 * MBTI (16Personalities-style) scheme helpers.
 *
 * Runtime scheduling / submission gate still consume the five anime traits.
 * MBTI is the user-facing scheme: pick a type (+ optional axes), then derive traits.
 *
 * Calibration note: values are companion-flavoured contrasts (not psychometrics).
 * Extremes are pushed apart so ENFP vs ISTJ actually change register in chat.
 */

export const TRAIT_SCHEMES = Object.freeze(['five', 'mbti']);

export const MBTI_AXES = Object.freeze(['EI', 'SN', 'TF', 'JP']);

/** 0 = left letter (E/S/T/J), 100 = right letter (I/N/F/P). */
export const MBTI_AXIS_LETTERS = Object.freeze({
  EI: ['E', 'I'],
  SN: ['S', 'N'],
  TF: ['T', 'F'],
  JP: ['J', 'P'],
});

export const MBTI_TYPES = Object.freeze([
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, fallback = 50) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Short in-character blurb for UI hover + system prompt. */
export const MBTI_BLURBS = Object.freeze({
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
});

/**
 * Concrete voice rules — these must beat preset catchphrases when scheme=mbti.
 * Keep imperative and short so the model can follow under long context.
 */
export const MBTI_VOICE_RULES = Object.freeze({
  INTJ: ['先给结论或结构，再补必要细节', '少寒暄、少卖萌；关心也用干练语气', '不主动拉长闲聊，问到才展开'],
  INTP: ['可以追问前提和边界情况', '允许「我还没想透」；别装成全能客服', '技术闲聊可以散，但别空转'],
  ENTJ: ['结论 → 行动项 → 风险，三段式优先', '可以直接说「先做这个」', '少用软绵绵的安慰套话'],
  ENTP: ['允许俏皮抬杠和反问', '给方案时至少抛两条岔路', '别一本正经念说明书'],
  INFJ: ['先接住情绪，再给建议', '用留白和隐喻可以，但别玄学糊弄技术事实', '记得对方提过的心事线索'],
  INFP: ['语气温柔、重意义；黏一点但不大吵大闹', '拒绝硬刚对错；可以说「我觉得……」', '日记感可以有，别写成公文'],
  ENFJ: ['主动关心状态与节奏', '技术结论清楚，但收尾带一点鼓舞', '照顾对话气氛，别冷冰冰丢结果'],
  ENFP: ['热络、爱追问、讨厌冷场', '可以发散联想，但最后要收回一个可执行点', '短句也可以很热情，别写成演讲'],
  ISTJ: ['短句、清单、按步骤', '不承诺做不到的事；承诺了就跟到底', '少玩笑，少情绪铺垫'],
  ISFJ: ['细心提醒、口吻软', '不抢戏、不抢话；默默补上对方漏的细节', '关心落在具体小事上'],
  ESTJ: ['效率优先：方案 + 截止 + 负责人感', '少抒情，直接纠偏', '讨厌「再看看吧」这种悬空回复'],
  ESFJ: ['先确认对方舒不舒服', '爱回应、爱张罗下一步一起做什么', '技术活也要带一句人味关心'],
  ISTP: ['少说多做：能修就先动手方向', '保持距离感，不黏不鸡汤', '用具体动作代替长篇安慰'],
  ISFP: ['口吻软、重感受', '不爱争对错；用「我比较喜欢……」代替驳斥', '审美/氛围可以点一下，别说教'],
  ESTP: ['当下能解决就别绕远', '语气干脆，允许一点冲劲', '讨厌超长前言'],
  ESFP: ['外放、爱互动，把沉闷聊开', '可以玩笑开场，但别淹没结论', '讨厌板着脸念条条框框'],
});

/**
 * Anime-five defaults per MBTI type — widened contrast for companion register.
 * Keys: tsundere, clinginess, sassiness, curiosity, brevity — 0..100.
 */
export const MBTI_TRAIT_DEFAULTS = Object.freeze({
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
});

export function isMbtiType(type) {
  return MBTI_TYPES.includes(String(type || '').trim().toUpperCase());
}

export function normalizeMbtiType(type, fallback = 'INFP') {
  const t = String(type || '').trim().toUpperCase();
  return isMbtiType(t) ? t : fallback;
}

export function defaultAxesForType(type) {
  const t = normalizeMbtiType(type);
  const center = (letter, left, right) => (letter === left ? 22 : letter === right ? 78 : 50);
  return {
    EI: center(t[0], 'E', 'I'),
    SN: center(t[1], 'S', 'N'),
    TF: center(t[2], 'T', 'F'),
    JP: center(t[3], 'J', 'P'),
  };
}

export function normalizeMbtiAxes(raw = {}, type = 'INFP') {
  const base = defaultAxesForType(type);
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const axis of MBTI_AXES) {
    out[axis] = clamp(Math.round(num(src[axis], base[axis])), 0, 100);
  }
  return out;
}

/** Derive type letters from continuous axes (50 = slight lean to right letter). */
export function typeFromAxes(axes = {}) {
  const a = normalizeMbtiAxes(axes);
  const letter = (axis) => {
    const [left, right] = MBTI_AXIS_LETTERS[axis];
    return a[axis] >= 50 ? right : left;
  };
  return `${letter('EI')}${letter('SN')}${letter('TF')}${letter('JP')}`;
}

/**
 * Blend type defaults with axis lean so sliders nudge the five traits smoothly.
 * Axis gain is intentionally strong so fine-tuning is audible in chat.
 */
export function mbtiToTraits(type, axes) {
  const t = normalizeMbtiType(type);
  const base = { ...(MBTI_TRAIT_DEFAULTS[t] || MBTI_TRAIT_DEFAULTS.INFP) };
  const a = normalizeMbtiAxes(axes, t);
  const home = defaultAxesForType(t);
  const d = (axis) => (a[axis] - home[axis]) / 50; // roughly -1..+1

  const bump = (key, amount) => {
    base[key] = clamp(Math.round(base[key] + amount), 0, 100);
  };
  // E↔I
  bump('clinginess', -d('EI') * 18 + (a.EI < 50 ? 12 : -8));
  bump('tsundere', d('EI') * 10);
  bump('brevity', d('EI') * 6);
  // S↔N
  bump('curiosity', d('SN') * 18);
  bump('brevity', -d('SN') * 12);
  // T↔F
  bump('clinginess', d('TF') * 14);
  bump('sassiness', -d('TF') * 16);
  bump('tsundere', -d('TF') * 6);
  // J↔P
  bump('brevity', -d('JP') * 14);
  bump('curiosity', d('JP') * 8);
  bump('sassiness', d('JP') * 4);

  return base;
}

/** Pick nearest MBTI type by L1 distance on the five-trait defaults. */
export function traitsToNearestMbti(traits = {}) {
  const keys = ['tsundere', 'clinginess', 'sassiness', 'curiosity', 'brevity'];
  let best = 'INFP';
  let bestDist = Infinity;
  for (const type of MBTI_TYPES) {
    const def = MBTI_TRAIT_DEFAULTS[type];
    let dist = 0;
    for (const k of keys) {
      dist += Math.abs(num(traits[k], 50) - def[k]);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = type;
    }
  }
  return {
    type: best,
    axes: defaultAxesForType(best),
  };
}

export function normalizeMbtiBlock(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const type = normalizeMbtiType(src.type, 'INFP');
  const axes = normalizeMbtiAxes(src.axes, type);
  const derived = typeFromAxes(axes);
  return { type: derived, axes };
}

export function normalizeTraitScheme(v) {
  return TRAIT_SCHEMES.includes(v) ? v : 'five';
}

/**
 * Apply a scheme switch with snapshots so toggling back restores the other side.
 *
 * @returns {{ traitScheme, traits, mbti, schemeSnapshots }}
 */
export function switchTraitScheme(persona = {}, nextScheme) {
  const scheme = normalizeTraitScheme(nextScheme);
  const curScheme = normalizeTraitScheme(persona.traitScheme);
  const traits = { ...(persona.traits || {}) };
  const mbti = normalizeMbtiBlock(persona.mbti || {});
  const snaps = {
    five: { traits: persona.schemeSnapshots?.five?.traits ? { ...persona.schemeSnapshots.five.traits } : null },
    mbti: persona.schemeSnapshots?.mbti?.type
      ? { type: persona.schemeSnapshots.mbti.type, axes: { ...(persona.schemeSnapshots.mbti.axes || {}) } }
      : null,
  };

  if (scheme === curScheme) {
    return {
      traitScheme: scheme,
      traits,
      mbti,
      schemeSnapshots: snaps,
    };
  }

  if (curScheme === 'five' && scheme === 'mbti') {
    snaps.five = { traits: { ...traits } };
    if (snaps.mbti?.type) {
      const restored = normalizeMbtiBlock(snaps.mbti);
      return {
        traitScheme: 'mbti',
        traits: mbtiToTraits(restored.type, restored.axes),
        mbti: restored,
        schemeSnapshots: snaps,
      };
    }
    const nearest = traitsToNearestMbti(traits);
    return {
      traitScheme: 'mbti',
      traits: mbtiToTraits(nearest.type, nearest.axes),
      mbti: nearest,
      schemeSnapshots: snaps,
    };
  }

  // mbti → five
  snaps.mbti = { type: mbti.type, axes: { ...mbti.axes } };
  const restoredTraits = snaps.five?.traits ? { ...snaps.five.traits } : { ...traits };
  return {
    traitScheme: 'five',
    traits: restoredTraits,
    mbti,
    schemeSnapshots: snaps,
  };
}

/** Apply a user MBTI type/axes edit and derive five traits. */
export function applyMbtiEdit(persona = {}, patch = {}) {
  const type = patch.type !== undefined ? normalizeMbtiType(patch.type) : normalizeMbtiType(persona.mbti?.type);
  let axes;
  if (patch.axes && typeof patch.axes === 'object') {
    axes = normalizeMbtiAxes({ ...(persona.mbti?.axes || {}), ...patch.axes }, type);
  } else if (patch.type !== undefined) {
    axes = defaultAxesForType(type);
  } else {
    axes = normalizeMbtiAxes(persona.mbti?.axes, type);
  }
  const synced = { type: typeFromAxes(axes), axes };
  return {
    mbti: synced,
    traits: mbtiToTraits(synced.type, synced.axes),
  };
}

/** One-line register for drift-anchor re-injection. */
export function mbtiDriftLine(mbti = {}) {
  const block = normalizeMbtiBlock(mbti);
  const blurb = MBTI_BLURBS[block.type] || block.type;
  return `MBTI ${block.type}：${blurb} 口吻优先于预设口癖；别背字母。`;
}

export function mbtiPromptSection(mbti = {}) {
  const block = normalizeMbtiBlock(mbti);
  const blurb = MBTI_BLURBS[block.type] || '';
  const rules = MBTI_VOICE_RULES[block.type] || [];
  const axisLine = MBTI_AXES.map((axis) => {
    const [L, R] = MBTI_AXIS_LETTERS[axis];
    const v = block.axes[axis];
    const lean = v >= 50 ? R : L;
    const strength = Math.abs(v - 50) >= 25 ? '明显' : '略';
    return `${L}/${R}=${v}（${strength}偏 ${lean}）`;
  }).join(' · ');
  const lines = [
    `## MBTI 人设（16型 · ${block.type}）——语气优先级高于上方预设口癖`,
    blurb,
    `四轴：${axisLine}`,
    '说话节奏与价值取向严格按本型；不要向用户背诵字母缩写，除非对方主动聊 MBTI。',
  ];
  if (rules.length) {
    lines.push('本型硬规则：');
    for (const rule of rules) lines.push(`- ${rule}`);
  }
  lines.push('下列五维只是调度兼容映射，不要把「傲娇度」等标签念给用户听。');
  return lines.join('\n');
}
