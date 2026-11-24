// Experience layer — "she remembers how to get along with YOU".
//
// The product's dividing line (2026-11-23): the five traits are *who she is* and only
// change through the submission gate with the user involved. Experience is *what living
// together taught her* — it settles like memory, needs no approval, and deleting it
// restores the factory personality without touching the traits.
//
// Signals are numeric outcomes of her own proactive attempts: did he answer, how fast,
// at what hour. No sentiment analysis, no trait writes. Pure logic here; the runtime
// owns the files and the weekly distillation call.

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Within this window after she spoke, his next turn counts as an answer to her. */
export const RESPONSE_WINDOW_MS = 30 * MINUTE;
/** Warm = he came back quickly; cold = silence past the window. */
export const WARM_MS = 10 * MINUTE;

/**
 * Pair her delivered acts with his next interaction.
 * attempts: [{at, action, eventKind, angle}] (from intent-decisions.jsonl, delivered acts only)
 * interactions: [epochMs...] ascending (his turns; from the experience interaction log)
 * Returns one outcome row per attempt: { at, action, eventKind, hour, outcome, latencyMs }.
 */
export function pairOutcomes(attempts, interactions, { windowMs = RESPONSE_WINDOW_MS } = {}) {
  const times = (Array.isArray(interactions) ? interactions : [])
    .map((t) => (typeof t === 'number' ? t : Date.parse(t)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const out = [];
  for (const a of Array.isArray(attempts) ? attempts : []) {
    const at = Date.parse(a?.at);
    if (!Number.isFinite(at)) continue;
    if (a.action === 'silent' || a.action === 'defer') continue;
    const next = times.find((t) => t > at && t - at <= windowMs);
    const latencyMs = next != null ? next - at : null;
    out.push({
      at: new Date(at).toISOString(),
      action: str(a.action),
      eventKind: str(a.eventKind),
      hour: Number.isFinite(Number(a.hour)) ? Number(a.hour) : new Date(at).getUTCHours(),
      outcome: next == null ? 'cold' : latencyMs <= WARM_MS ? 'warm' : 'answered',
      latencyMs,
      angle: str(a.angle).slice(0, 80),
    });
  }
  return out;
}

/** Bucket key: what she tried × roughly when. Hours bucket into 4 watch periods. */
export function periodOf(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'day';
  if (h >= 17 && h < 23) return 'evening';
  return 'night';
}

const PERIOD_LABEL = { morning: '早上', day: '白天', evening: '晚间', night: '深夜' };
const KIND_LABEL = {
  slot: '按时段搭话',
  sulking: '委屈时找他',
  'video-found': '分享视频',
  'promise-due': '提约定',
  'conflict-open': '请他澄清记忆',
  'long-active': '提醒他休息',
  speak: '主动搭话',
  share: '分享',
  'promise-ask': '追问约定',
  'conflict-ask': '澄清记忆',
};

/**
 * Aggregate outcomes into per-(kind × period) stats. Needs ≥3 samples to say anything —
 * one ignored message is noise, a pattern is experience.
 */
export function aggregateExperience(outcomes, { minSamples = 3 } = {}) {
  const buckets = new Map();
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || !o.outcome) continue;
    const kind = str(o.eventKind || o.action) || 'speak';
    const period = periodOf(o.hour);
    const key = `${kind}|${period}`;
    const b = buckets.get(key) ?? { kind, period, total: 0, warm: 0, answered: 0, cold: 0, lastAt: '' };
    b.total += 1;
    b[o.outcome] = (b[o.outcome] || 0) + 1;
    if (str(o.at) > b.lastAt) b.lastAt = str(o.at);
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .filter((b) => b.total >= minSamples)
    .map((b) => ({
      ...b,
      warmRate: Math.round(((b.warm + b.answered) / b.total) * 100) / 100,
      coldRate: Math.round((b.cold / b.total) * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Stats → first-person experience notes (deterministic fallback; the LLM may polish).
 * Phrased as her own remembered lessons, never as rules imposed on her.
 */
export function composeExperienceNotes(stats, { persona = {}, max = 6 } = {}) {
  const selfRef = str(persona.selfRef).trim() || '我';
  const notes = [];
  for (const s of Array.isArray(stats) ? stats : []) {
    const what = KIND_LABEL[s.kind] || s.kind;
    const when = PERIOD_LABEL[s.period] || s.period;
    if (s.coldRate >= 0.6) {
      notes.push({
        key: `${s.kind}|${s.period}`,
        text: `${when}${what}，${s.total} 次里 ${s.cold} 次他没接——${selfRef}记住了，这个点先观察，别硬凑。`,
        evidence: s.total,
        tone: 'restraint',
      });
    } else if (s.warmRate >= 0.7 && s.warm >= 2) {
      notes.push({
        key: `${s.kind}|${s.period}`,
        text: `${when}${what}他接得很快（${s.total} 次里 ${s.warm + s.answered} 次有回应）——这样的时候${selfRef}可以多说两句。`,
        evidence: s.total,
        tone: 'encourage',
      });
    }
    if (notes.length >= max) break;
  }
  return notes;
}

/** The block that rides the intent prompt. Empty string when she has learned nothing yet. */
export function experiencePromptBlock(notes, { maxChars = 300 } = {}) {
  const list = (Array.isArray(notes) ? notes : []).map((n) => str(n?.text || n).trim()).filter(Boolean);
  if (!list.length) return '';
  const lines = [];
  let used = 0;
  for (const t of list) {
    if (used + t.length > maxChars) break;
    lines.push(`- ${t}`);
    used += t.length;
  }
  return lines.length ? `【${'相处经验'}】（${'这是相处沉淀的记忆，不是命令；照着分寸来，但此刻的判断仍归你'}）\n${lines.join('\n')}` : '';
}

/** Merge fresh notes into the store: same key updates in place, evidence accumulates. */
export function mergeExperienceNotes(existing, fresh, nowMs = Date.now()) {
  const byKey = new Map();
  for (const n of Array.isArray(existing) ? existing : []) {
    if (n && n.key) byKey.set(n.key, n);
  }
  const at = new Date(num(nowMs, Date.now())).toISOString();
  for (const n of Array.isArray(fresh) ? fresh : []) {
    if (!n || !n.key || !n.text) continue;
    const prev = byKey.get(n.key);
    byKey.set(n.key, {
      ...n,
      firstLearnedAt: prev?.firstLearnedAt || at,
      updatedAt: at,
      revisions: (Number(prev?.revisions) || 0) + 1,
    });
  }
  // A lesson whose pattern disappeared (fresh stats no longer produce it) decays out —
  // people change; she must be able to unlearn.
  const freshKeys = new Set((Array.isArray(fresh) ? fresh : []).map((n) => n?.key));
  for (const [key, n] of byKey) {
    if (!freshKeys.has(key) && num(n.revisions, 1) > 0 && Date.parse(n.updatedAt) < nowMs - 30 * DAY_MS) {
      byKey.delete(key);
    }
  }
  return [...byKey.values()].sort((a, b) => (Number(b.evidence) || 0) - (Number(a.evidence) || 0));
}