// Optional import from dsh-bili-whale's ~/.bili-ai/credentials.json (never required).
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBiliCookieText } from './cookie.mjs';
import { saveBiliCredentials } from './credentials.mjs';
import { fetchBiliNav } from './nav.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const errMsg = (err) => (err instanceof Error ? err.message : String(err));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function defaultWhaleCredentialsPath() {
  return join(homedir(), '.bili-ai', 'credentials.json');
}

/** Normalize whale / community credential shapes into our fields. */
export function normalizeWhaleCredentials(raw) {
  if (!isObject(raw)) return { sessdata: '', biliJct: '', uid: '', buvid3: '' };
  // Flat cookie string
  if (typeof raw.cookie === 'string' && raw.cookie.includes('SESSDATA=')) {
    return parseBiliCookieText(raw.cookie);
  }
  const sessdata = str(raw.SESSDATA || raw.sessdata || raw.biliSessdata || raw.sess_data);
  const biliJct = str(raw.bili_jct || raw.biliJct || raw.csrf || raw.csrfToken);
  const uid = str(raw.DedeUserID || raw.dedeUserID || raw.uid || raw.mid || raw.biliUid);
  const buvid3 = str(raw.buvid3 || raw.Buvid3 || raw.biliBuvid3);
  if (sessdata || biliJct) return { sessdata, biliJct, uid, buvid3 };
  // Nested cookies object
  if (isObject(raw.cookies)) return normalizeWhaleCredentials(raw.cookies);
  return { sessdata: '', biliJct: '', uid: '', buvid3: '' };
}

/**
 * Read whale credentials file → nav verify → atomic write into soulmate credentials.
 * options.whaleCredentialsPath injectable for tests.
 */
export async function importWhaleCredentials(home, options = {}) {
  const path = str(options.whaleCredentialsPath || defaultWhaleCredentialsPath());
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      code: 'whale_missing',
      error: `读不到 whale 凭据（${path}）：${errMsg(err)}`,
    };
  }
  const parsed = normalizeWhaleCredentials(raw);
  if (!parsed.sessdata || !parsed.biliJct) {
    return { ok: false, code: 'whale_incomplete', error: 'whale 凭据缺少 SESSDATA 或 bili_jct' };
  }

  const nav = await fetchBiliNav(parsed, options);
  if (!nav.ok || !nav.loggedIn) {
    return {
      ok: false,
      code: nav.code || 'nav_not_logged_in',
      error: nav.error || 'whale 凭据未能通过 nav 校验，未写入',
    };
  }

  await saveBiliCredentials(home, {
    sessdata: parsed.sessdata,
    biliJct: parsed.biliJct,
    uid: nav.uid || parsed.uid,
    uname: nav.uname,
    buvid3: parsed.buvid3 || undefined,
  });

  return {
    ok: true,
    source: 'whale',
    loggedIn: true,
    uid: nav.uid || parsed.uid,
    uname: nav.uname,
  };
}
