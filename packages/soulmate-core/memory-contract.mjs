// Memory contract v3 (design 2026-11-09-soulmate-memory-v2-design.md §1–§3).
//
// v2 carried `kind / text / t / salience / confidence / evidence` and a four-term
// recall score. v3 adds the companion layer on top, without breaking old rows:
//
//   decayClass   — HOW a memory should be forgotten (orthogonal to `kind`)
//   provenance   — where/when she learned it (the "I remember because…" narrative)
//   promise      — lifecycle state for promises (made/kept/broken/released)
//   conflictWith — the trust protocol: contradictions are parked, never silent
//
// Every helper stays pure and total: a legacy row (topic/content/importance)
// still normalises into a full v3 record, so old stores, remote payloads and
// old clients keep working while new writes carry the whole contract.
//
// Read path is permissive (stored half-lives are honoured); the WRITE path goes
// through resolveHalfLifeDays(), which enforces the decay-class defaults.

const DAY_MS = 86_400_000;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const toMs = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/** Memory kinds from the design: an episodic beat, a durable fact, or a promise. */
export const MEMORY_KINDS = Object.freeze(['episodic', 'semantic', 'promise']);

/**
 * Decay classes (§1): the semantic answer to "how should this be forgotten".
 * - halfLifeDays: default curve for new writes (0 = never decays);
 * - reinforceGain: how much recalling stretches the curve (0 = never stretches);
 * - presence: eligible for the always-in-context Presence Digest (§4);
 * - trimRank: higher is trimmed later when the digest must shrink.
 */
export const DECAY_CLASSES = Object.freeze({
  preference: Object.freeze({ halfLifeDays: 0, reinforceGain: 0, presence: true, trimRank: 4 }),
  promise: Object.freeze({ halfLifeDays: 0, reinforceGain: 0, presence: true, trimRank: 5 }),
  fact: Object.freeze({ halfLifeDays: 180, reinforceGain: 1.3, presence: true, trimRank: 3 }),
  event: Object.freeze({ halfLifeDays: 90, reinforceGain: 1.3, presence: false, trimRank: 2 }),
  emotion: Object.freeze({ halfLifeDays: 21, reinforceGain: 0, presence: false, trimRank: 1 }),
});
export const DEFAULT_DECAY_CLASS = 'fact';
/** Presence Digest whitelist (§4.2 item 3); promises attach separately, in full. */
export const PRESENCE_DECAY_CLASSES = Object.freeze(['preference', 'fact']);

/** Recall weights — v2 split (design §3.2): relationship is no longer a garnish. */
export const RECALL_WEIGHTS = Object.freeze({
  similarity: 0.45,
  salience: 0.2,
  recency: 0.15,
  relationship: 0.2,
});

/** Confidence bands (§4 置信四态): assert / hold / ask, plus conflict (a relation, not a number). */
export const CONFIDENCE_BANDS = Object.freeze({
  assert: 0.8,
  hold: 0.55,
});

export function confidenceBand(confidenceOrFact) {
  // v3: conflict is a relation between two memories, so an object with a live
  // conflictWith pointer always reads as 'conflict', whatever its confidence.
  if (typeof confidenceOrFact === 'object' && confidenceOrFact !== null) {
    if (str(confidenceOrFact.conflictWith).trim()) return 'conflict';
    return confidenceBand(confidenceOrFact.confidence);
  }
  // Same default as normalizeFact, so a missing confidence is not read as doubt.
  const c = clamp(num(confidenceOrFact, 0.6), 0, 1);
  if (c >= CONFIDENCE_BANDS.assert) return 'assert';
  if (c >= CONFIDENCE_BANDS.hold) return 'hold';
  return 'ask';
}

/** A promise never decays; everything else follows its decay class (§1). */
export const PROMISE_HALF_LIFE_DAYS = 0;
export const DEFAULT_HALF_LIFE_DAYS = 90;

export function halfLifeFor(kind, requested) {
  if (kind === 'promise') return PROMISE_HALF_LIFE_DAYS;
  const n = num(requested, 0);
  return n > 0 ? n : DEFAULT_HALF_LIFE_DAYS;
}

export const decayMeta = (decayClass) =>
  DECAY_CLASSES[decayClass] ?? DECAY_CLASSES[DEFAULT_DECAY_CLASS];

/** Default curve of a decay class (new writes). */
export const decayHalfLifeFor = (decayClass) => decayMeta(decayClass).halfLifeDays;

/** How much a recall stretches the curve for this class (0 = never). */
export const reinforceGain = (decayClass) => decayMeta(decayClass).reinforceGain;

/** Trim order for the Presence Digest: higher survives longer. */
export const trimRank = (decayClass) => decayMeta(decayClass).trimRank;

export const isPresenceClass = (decayClass) => decayMeta(decayClass).presence === true;

/**
 * Write-path half-life resolver (§1): callers may nudge a curve by ±50% of the
 * class default, never invent one. Out-of-range requests fail loudly so a
 * stray 30/45/120/180 mix can never re-accumulate.
 */
export function resolveHalfLifeDays({ kind, decayClass, requested } = {}) {
  if (kind === 'promise') return { ok: true, value: PROMISE_HALF_LIFE_DAYS };
  const cls = DECAY_CLASSES[decayClass] ? decayClass : DEFAULT_DECAY_CLASS;
  const base = decayHalfLifeFor(cls);
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, value: base };
  }
  const n = Number(requested);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: `halfLifeDays must be a non-negative number, got ${requested}` };
  }
  if (base === 0) {
    return n === 0
      ? { ok: true, value: 0 }
      : { ok: false, error: `decayClass "${cls}" never decays; halfLifeDays must stay 0` };
  }
  if (n < base * 0.5 || n > base * 1.5) {
    return {
      ok: false,
      error: `halfLifeDays ${n} outside ±50% of the "${cls}" default ${base} (${base * 0.5}..${base * 1.5})`,
    };
  }
  return { ok: true, value: n };
}

const EVENT_CATEGORIES = Object.freeze(['video', 'event', 'bili', 'episode']);
const EMOTION_CATEGORIES = Object.freeze(['emotion', 'mood']);

/** Infer the decay class of any stored/remote row (§1 rules, order matters). */
export function inferDecayClass(raw = {}) {
  if (DECAY_CLASSES[raw.decayClass]) return raw.decayClass;
  if (raw.kind === 'promise') return 'promise';
  const category = str(raw.category).trim().toLowerCase();
  if (category === 'preference') return 'preference';
  if (EMOTION_CATEGORIES.includes(category)) return 'emotion';
  if (EVENT_CATEGORIES.includes(category) || raw.kind === 'episodic') return 'event';
  return DEFAULT_DECAY_CLASS;
}

/** importance (1..5, the legacy dial) → salience (0..1). Kept for old rows. */
export function salienceFromImportance(importance) {
  return clamp(num(importance, 3) / 5, 0.05, 1);
}

const normalizeProvenance = (raw, fallbackAt) => {
  const p = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
  return {
    source: str(p.source).trim() || 'legacy',
    sessionId: str(p.sessionId).trim() || null,
    at: str(p.at).trim() || fallbackAt,
  };
};

const normalizePromise = (raw) => {
  const p = raw.promise && typeof raw.promise === 'object' ? raw.promise : {};
  const status = ['made', 'kept', 'broken', 'released'].includes(p.status) ? p.status : 'made';
  return {
    status,
    dueAt: str(p.dueAt).trim() || null,
    note: str(p.note).trim() || null,
  };
};

/**
 * Normalise any stored/remote row into the full v3 contract.
 * Legacy rows are migrated on read, so nothing has to be rewritten up front.
 */
export function normalizeFact(raw = {}) {
  const kind = MEMORY_KINDS.includes(raw.kind) ? raw.kind : 'semantic';
  const text = str(raw.text) || [str(raw.topic), str(raw.content)].filter(Boolean).join('：');
  const t = str(raw.t) || str(raw.createdAt) || str(raw.updatedAt) || new Date(0).toISOString();
  const salience = Number.isFinite(Number(raw.salience))
    ? clamp(Number(raw.salience), 0, 1)
    : salienceFromImportance(raw.importance);
  const confidence = Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : 0.6;
  const decayClass = inferDecayClass({ ...raw, kind });
  return {
    ...raw,
    kind,
    text,
    t,
    salience,
    confidence,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(str).filter(Boolean) : [],
    decayClass,
    provenance: normalizeProvenance(raw, t),
    promise: kind === 'promise' ? normalizePromise(raw) : null,
    conflictWith: str(raw.conflictWith).trim() || null,
    conflictOpenedAt: str(raw.conflictOpenedAt).trim() || null,
    // Read path stays permissive: a stored legacy half-life is honoured as-is.
    halfLifeDays: halfLifeFor(kind, raw.halfLifeDays),
    // Legacy views keep working: topic/content/importance are projected from the contract.
    topic: str(raw.topic) || str(raw.text),
    content: str(raw.content) || str(raw.text),
    importance: clamp(Math.round(num(raw.importance, salience * 5)), 1, 5),
  };
}

/**
 * Recency in 0..1. Zero-half-life classes never decay; recalling stretches the
 * curve by the class gain (preference/emotion/promise: never).
 */
export function recencyOf(fact, nowMs) {
  const half = num(fact.halfLifeDays, DEFAULT_HALF_LIFE_DAYS);
  if (!(half > 0)) return 1;
  const gain = reinforceGain(inferDecayClass(fact));
  const anchor = toMs(fact.lastRecalledAt) || toMs(fact.updatedAt) || toMs(fact.t) || nowMs;
  const stretched = half * (1 + 0.3 * gain * num(fact.recallCount, 0));
  return clamp(2 ** (-Math.max(0, nowMs - anchor) / DAY_MS / stretched), 0, 1);
}

/**
 * Relationship term in 0..1 (design §3.2): how much this memory plugs into the
// bond you two actually have, plus how entangled it is with recent shared events.
 *   0.5·tie + 0.3·bond + 0.2·coEvent
 */
export function relationshipOf(fact, relationship = {}, coEvent = 0) {
  const warmth = clamp(num(relationship.warmth, 0) / 100, 0, 1);
  const trust = clamp(num(relationship.trust, 0) / 100, 0, 1);
  const bond = (warmth + trust) / 2;
  const tie = fact.kind === 'promise' ? 1 : clamp(num(fact.confidence, 0.5), 0, 1);
  return clamp(0.5 * tie + 0.3 * bond + 0.2 * clamp(num(coEvent, 0), 0, 1), 0, 1);
}

/**
 * The four-term recall score. Similarity is passed in already normalised to
 * 0..1 by the caller, which owns tokenisation.
 */
export function recallScore({ similarity, fact, nowMs, relationship, coEvent = 0 }) {
  const s = clamp(num(similarity, 0), 0, 1);
  const salience = clamp(num(fact.salience, 0.5), 0, 1);
  const recency = recencyOf(fact, nowMs);
  const rel = relationshipOf(fact, relationship, coEvent);
  const score =
    RECALL_WEIGHTS.similarity * s +
    RECALL_WEIGHTS.salience * salience +
    RECALL_WEIGHTS.recency * recency +
    RECALL_WEIGHTS.relationship * rel;
  return {
    score: Math.round(score * 10_000) / 10_000,
    parts: { similarity: s, salience, recency, relationship: rel },
  };
}
