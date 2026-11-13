// Parse pasted Cookie strings / Set-Cookie headers into Bilibili login fields.
// Never logs or returns secrets to callers beyond structured fields they already asked for.

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const COOKIE_KEYS = Object.freeze({
  SESSDATA: 'sessdata',
  bili_jct: 'biliJct',
  DedeUserID: 'uid',
  buvid3: 'buvid3',
});

function takePair(map, rawKey, rawVal) {
  const key = str(rawKey).trim();
  const val = str(rawVal).trim();
  if (!key || !val) return;
  const mapped = COOKIE_KEYS[key];
  if (mapped) map[mapped] = val;
}

/**
 * Accepts:
 * - `SESSDATA=...; bili_jct=...; DedeUserID=...`
 * - multiline `key=value`
 * - array of Set-Cookie header values
 */
export function parseBiliCookieText(input) {
  const out = { sessdata: '', biliJct: '', uid: '', buvid3: '' };
  if (Array.isArray(input)) {
    for (const line of input) parseOneLine(out, line);
    return out;
  }
  const text = str(input).trim();
  if (!text) return out;
  // Prefer semicolon-separated cookie jar; also accept newlines.
  const chunks = text.split(/[\n\r]+/).flatMap((line) => {
    const t = line.trim();
    if (!t) return [];
    if (t.includes(';')) return t.split(';');
    return [t];
  });
  for (const chunk of chunks) parseOneLine(out, chunk);
  return out;
}

function parseOneLine(out, chunk) {
  const raw = str(chunk).trim();
  if (!raw) return;
  // Set-Cookie: name=value; Path=/; HttpOnly
  const first = raw.split(';')[0] ?? raw;
  const eq = first.indexOf('=');
  if (eq <= 0) return;
  takePair(out, first.slice(0, eq), first.slice(eq + 1));
}

/** Build a Cookie request header from credential fields (no extras). */
export function buildBiliCookieHeader({ sessdata, biliJct, uid, buvid3 } = {}) {
  const parts = [];
  if (sessdata) parts.push(`SESSDATA=${sessdata}`);
  if (biliJct) parts.push(`bili_jct=${biliJct}`);
  if (uid) parts.push(`DedeUserID=${uid}`);
  if (buvid3) parts.push(`buvid3=${buvid3}`);
  return parts.join('; ');
}
