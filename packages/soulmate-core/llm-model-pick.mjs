/**
 * Pick the cheapest host model for optional dream / distill LLM paths.
 * Price when advertised; otherwise flash → lite → mini → small → nano heuristic.
 */

const str = (v) => (v == null ? '' : String(v));

const TIER_RE = [
  [/flash/i, 0],
  [/lite/i, 1],
  [/mini/i, 2],
  [/small/i, 3],
  [/nano/i, 4],
  [/haiku/i, 2],
];

function modelId(m) {
  return str(m?.id || m?.model || m?.name).trim();
}

/**
 * Non-chat models must never be auto-picked for text generation: a real catalog
 * carries tts / asr / image / embedding / realtime routes, and "cheapest flash"
 * happily chose one → the stream finished with zero text blocks, every attempt.
 * Explicit user preference still wins (they may know a route we don't).
 */
const NON_CHAT = /(tts|asr|audio|omni|realtime|livetranslate|embedding|image|wan2|z-image|qvq|ocr|-vl-|vl-flash|vl-plus|math|s2s|live-translate|gui-plus|deep-research|deep-search)/i;

export function isChatModel(m) {
  const id = modelId(m);
  if (!id) return false;
  if (m?.modality && m.modality !== 'text' && m.modality !== 'chat') return false;
  if (Array.isArray(m?.capabilities) && m.capabilities.length && !m.capabilities.includes('chat') && !m.capabilities.includes('text')) return false;
  return !NON_CHAT.test(id);
}

function modelLabel(m) {
  return str(m?.displayName || m?.title || m?.name || modelId(m)).trim() || modelId(m);
}

/** Lowest known unit price, or Infinity when unknown. */
function unitPrice(m) {
  const p =
    m?.pricing ||
    m?.price ||
    m?.cost ||
    null;
  if (!p || typeof p !== 'object') {
    const flat = Number(m?.pricePerMillion ?? m?.inputPrice ?? m?.promptPrice);
    return Number.isFinite(flat) && flat >= 0 ? flat : Infinity;
  }
  const candidates = [
    p.input,
    p.inputPerMillion,
    p.prompt,
    p.promptPerMillionTokens,
    p.completion,
    p.output,
    p.outputPerMillion,
  ]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return Infinity;
  return Math.min(...candidates);
}

function heuristicTier(id) {
  const hay = id;
  for (const [re, tier] of TIER_RE) {
    if (re.test(hay)) return tier;
  }
  return 50;
}

/**
 * @param {object[]} models
 * @returns {object[]} shallow copies sorted cheapest-first, with `_pickId`
 */
export function rankModelsCheapest(models) {
  const list = (Array.isArray(models) ? models : [])
    .map((m) => ({ ...m, _pickId: modelId(m), _pickLabel: modelLabel(m) }))
    .filter((m) => m._pickId);
  list.sort((a, b) => {
    const pa = unitPrice(a);
    const pb = unitPrice(b);
    if (pa !== pb) return pa - pb;
    const ta = heuristicTier(a._pickId);
    const tb = heuristicTier(b._pickId);
    if (ta !== tb) return ta - tb;
    return a._pickId.localeCompare(b._pickId);
  });
  return list;
}

/**
 * @param {{ models?: object[], preferredId?: string }} args
 * @returns {{ id: string, label: string, auto: boolean, model: object|null }}
 */
export function resolveLlmModel({ models = [], preferredId = '' } = {}) {
  const ranked = rankModelsCheapest(models);
  const want = str(preferredId).trim();
  if (want) {
    const hit = ranked.find((m) => m._pickId === want);
    if (hit) return { id: hit._pickId, label: hit._pickLabel, auto: false, model: hit };
  }
  const chatRanked = ranked.filter(isChatModel);
  const best = chatRanked[0] || null;
  if (!best) return { id: '', label: '', auto: true, model: null };
  return { id: best._pickId, label: best._pickLabel, auto: !want || want !== best._pickId, model: best };
}
