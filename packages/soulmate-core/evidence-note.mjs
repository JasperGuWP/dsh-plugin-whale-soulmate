/**
 * Evidence narration (v3 §12).
 *
 * A memory row has always carried `evidence: string[]` — the actual sentence the user said —
 * but nothing ever *showed* it. A recall hit was a flat assertion ("她怕黑") with no way to
 * tell a real lived detail from something the model guessed, which is exactly what makes a
 * companion feel like a database read instead of someone remembering you.
 *
 * This module turns a stored row back into a sentence a person could say out loud:
 *   "我记得，因为 11-03 你说过「我从小就怕黑，晚上不敢关灯」"
 *
 * Pure functions, no I/O — the caller decides where the line goes.
 */

const str = (v) => (v == null ? '' : String(v));

const clip = (s, n) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
};

/** `2026-11-03T21:14:00.000Z` → `11-03`; tolerates date-only and garbage. */
export function evidenceDay(value) {
  const raw = str(value).trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : '';
}

/**
 * Render one evidence quote as the "because you said it" half of a recall line.
 *
 * @param {object} fact a stored memory row
 * @param {{maxQuote?:number, maxItems?:number}} [options]
 * @returns {{text:string, quote:string, day:string}|null} null when there is no evidence
 */
export function narrateEvidence(fact, options = {}) {
  const maxQuote = Math.max(20, Number(options.maxQuote ?? 60));
  const maxItems = Math.max(1, Number(options.maxItems ?? 1));
  const list = (Array.isArray(fact?.evidence) ? fact.evidence : []).map(str).filter((q) => q.trim());
  if (!list.length) return null;
  const quotes = list.slice(0, maxItems).map((q) => clip(q, maxQuote));
  const day = evidenceDay(fact.t ?? fact.at ?? fact.updatedAt);
  const quote = quotes.join(' / ');
  return {
    quote,
    day,
    text: day ? `因为 ${day} 你说过「${quote}」` : `因为你说过「${quote}」`,
  };
}

/**
 * Attach a human-readable `evidenceNote` to every fact that has evidence.
 * Facts without evidence pass through untouched — never invent a source.
 *
 * @param {object[]} facts recall hits
 * @param {object} [options] forwarded to {@link narrateEvidence}
 */
export function withEvidenceNotes(facts, options = {}) {
  const list = Array.isArray(facts) ? facts : [];
  return list.map((f) => {
    const narrated = narrateEvidence(f, options);
    return narrated ? { ...f, evidenceNote: narrated.text, evidenceDay: narrated.day } : f;
  });
}

/** How many of the hits can actually be traced back to something the user said. */
export function countWithEvidence(facts) {
  const list = Array.isArray(facts) ? facts : [];
  return list.filter((f) => Array.isArray(f?.evidence) && f.evidence.length > 0).length;
}