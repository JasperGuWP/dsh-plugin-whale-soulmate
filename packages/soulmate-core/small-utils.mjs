// Tiny shared pure helpers used across the core assembly and its tool/route modules.

export const errMsg = (err) => (err instanceof Error ? err.message : String(err));
export const str = (v) => (v == null ? '' : String(v));
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clip = (s, n) => {
  const t = typeof s === 'string' ? s : '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
