// Scheduling layer — Week 1: derived strategy params only (edge ⑤ read-only view).
// Real Opening Gate / cognitive budget enforcement lands in Week 2.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Map effective traits → strategy knobs the UI can show.
 * Does NOT open sessions or change model tier (edge ⑦ deferred).
 */
export function deriveStrategyParams(effectiveTraits = {}) {
  const cling = Number(effectiveTraits.clinginess) || 50;
  const sass = Number(effectiveTraits.sassiness) || 50;
  const curios = Number(effectiveTraits.curiosity) || 50;
  const brevity = Number(effectiveTraits.brevity) || 50;
  const tsundere = Number(effectiveTraits.tsundere) || 50;

  // Higher clinginess / curiosity → more willingness to speak first.
  const initiative = clamp(Math.round(cling * 0.45 + curios * 0.35 + (100 - tsundere) * 0.2), 0, 100);
  // Silence threshold: hours of quiet before a proactive nudge is *considered* (not executed yet).
  const silenceThresholdHours = clamp(Math.round(48 - cling * 0.3 + tsundere * 0.1), 6, 72);
  // Tool surface: display-only permission story — persona never grants rights.
  const toolSurface = {
    memory: true,
    interact: true,
    video: curios >= 40,
    im: cling >= 45,
    note: '能不能用工具，看软件权限设置。',
  };

  return {
    initiative,
    silenceThresholdHours,
    toneBias: sass >= 70 ? 'sharp' : sass <= 30 ? 'gentle' : 'balanced',
    replyLengthBias: brevity >= 70 ? 'short' : brevity <= 30 ? 'detailed' : 'medium',
    toolSurface,
    openingGate: {
      mode: 'enforced',
      executor: 'soulmate-core/proactive.mjs',
      askFirst: initiative < 40,
      staySilentBelow: silenceThresholdHours,
    },
    weekNote: '会按作息与性格决定要不要主动找你；夜里可把白天零散记忆整理一下。',
  };
}

export function getSchedulingSnapshot(effectiveTraits) {
  return {
    strategy: deriveStrategyParams(effectiveTraits),
  };
}
