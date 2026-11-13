// Pure persona-change judgements used by the evolve pipeline: which identity
// fields moved, and whether the arc is big enough to narrate in the self-arc Wiki.

import { PRESETS, TRAIT_KEYS } from './persona.mjs';

export const RESET_MODES = ['reset_growth', 'reset_persona', 'full_rebirth'];
export const EVOLVE_MODES = ['user_customize', 'self_growth', 'appearance', ...RESET_MODES];

const TRAIT_LABEL_ZH = Object.freeze({
  tsundere: '傲娇度',
  clinginess: '粘人度',
  sassiness: '毒舌度',
  curiosity: '好奇心',
  brevity: '话少度',
});

/** First-person reason string for large persona arcs (主人翁语气). */
export function largePersonaArcReason(prevPersona = {}, nextPersona = {}) {
  if ((prevPersona.preset ?? null) !== (nextPersona.preset ?? null) && nextPersona.preset) {
    const preset = PRESETS[nextPersona.preset];
    return preset?.name ? `换了性格预设「${preset.name}」` : '换了性格预设';
  }
  if ((prevPersona.gender ?? null) !== (nextPersona.gender ?? null)) {
    if (nextPersona.gender === 'male') return '换了男声线';
    if (nextPersona.gender === 'female') return '换了女声线';
    return '声线变了';
  }
  const prevT = prevPersona.traits && typeof prevPersona.traits === 'object' ? prevPersona.traits : {};
  const nextT = nextPersona.traits && typeof nextPersona.traits === 'object' ? nextPersona.traits : {};
  for (const key of TRAIT_KEYS) {
    const delta = Math.abs((Number(nextT[key]) || 0) - (Number(prevT[key]) || 0));
    if (delta >= 20) {
      const label = TRAIT_LABEL_ZH[key] || key;
      return `五维「${label}」大幅调整`;
    }
  }
  const prevMbti = prevPersona.mbti?.type ?? null;
  const nextMbti = nextPersona.mbti?.type ?? null;
  if (prevMbti && nextMbti && prevMbti !== nextMbti) {
    return `MBTI 变成了 ${nextMbti}`;
  }
  return null;
}

export function identityFieldsChanged(prevPersona = {}, nextPersona = {}) {
  for (const key of ['name', 'callUser', 'selfRef', 'gender', 'preset']) {
    if ((prevPersona[key] ?? null) !== (nextPersona[key] ?? null)) return true;
  }
  return false;
}
