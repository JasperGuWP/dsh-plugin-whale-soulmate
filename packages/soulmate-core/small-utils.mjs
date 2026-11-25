// Tiny shared pure helpers used across the core assembly and its tool/route modules.

export const errMsg = (err) => (err instanceof Error ? err.message : String(err));
export const str = (v) => (v == null ? '' : String(v));
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clip = (s, n) => {
  const t = typeof s === 'string' ? s : '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * DSH's tool-output gate rejects any own key holding undefined ("value is not
 * lossless JSON") before serialization, so JSON.stringify alone cannot save a
 * payload. Drop undefined-valued keys recursively. Non-plain objects (Date,
 * Map, class instances) are kept as-is — the host gate flags those separately
 * and JSON semantics (toJSON) must survive. Cycles become null.
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen) ?? null);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const cleaned = jsonSafe(v, seen);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}
