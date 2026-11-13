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
  const best = ranked[0] || null;
  if (!best) return { id: '', label: '', auto: true, model: null };
  return { id: best._pickId, label: best._pickLabel, auto: !want || want !== best._pickId, model: best };
}
