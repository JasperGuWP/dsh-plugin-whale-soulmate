// Public Bilibili auth API — keep watch/surf/share out of this package surface.
import { parseBiliCookieText, buildBiliCookieHeader } from './cookie.mjs';
import {
  clearBiliCredentials,
  cookieFromCredentials,
  getBiliAuthStatus,
  loadBiliCredentialFields,
  saveBiliCredentials,
} from './credentials.mjs';
import { fetchBiliNav } from './nav.mjs';
import { mapQrPollCode, pollBiliQrLogin, startBiliQrLogin } from './qr-login.mjs';
import { defaultWhaleCredentialsPath, importWhaleCredentials, normalizeWhaleCredentials } from './whale-import.mjs';

export const BILI_AUTH_ACTIONS = Object.freeze([
  'status',
  'configure_cookie',
  'qr_start',
  'qr_poll',
  'import_whale',
  'verify',
  'clear',
]);

export {
  parseBiliCookieText,
  buildBiliCookieHeader,
  clearBiliCredentials,
  cookieFromCredentials,
  getBiliAuthStatus,
  loadBiliCredentialFields,
  saveBiliCredentials,
  fetchBiliNav,
  mapQrPollCode,
  pollBiliQrLogin,
  startBiliQrLogin,
  defaultWhaleCredentialsPath,
  importWhaleCredentials,
  normalizeWhaleCredentials,
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Nav-check current on-disk credentials (masked result). */
export async function verifyBiliLogin(home, options = {}) {
  const fields = await loadBiliCredentialFields(home);
  if (!fields.sessdata || !fields.biliJct) {
    return { ok: false, code: 'no_credentials', error: '还没有配置 B 站登录凭据', loggedIn: false };
  }
  const nav = await fetchBiliNav(fields, options);
  if (!nav.ok) return { ...nav, loggedIn: false };
  if (!nav.loggedIn) {
    return { ok: false, code: 'nav_not_logged_in', error: '凭据在线校验失败（未登录）', loggedIn: false };
  }
  // Refresh masked profile fields without echoing secrets.
  await saveBiliCredentials(home, { uid: nav.uid, uname: nav.uname });
  return { ok: true, loggedIn: true, uid: nav.uid, uname: nav.uname };
}

async function configureCookie(home, input = {}, options = {}) {
  const fromText = parseBiliCookieText(input.cookie || input.cookieText || '');
  const sessdata = str(input.sessdata || input.SESSDATA || fromText.sessdata).trim();
  const biliJct = str(input.biliJct || input.bili_jct || fromText.biliJct).trim();
  const uid = str(input.uid || input.DedeUserID || fromText.uid).trim();
  const buvid3 = str(input.buvid3 || fromText.buvid3).trim();
  if (!sessdata || !biliJct) {
    return { ok: false, code: 'incomplete_cookie', error: '需要 SESSDATA 与 bili_jct（F12 → Application → Cookies，不要用 document.cookie）' };
  }
  const nav = await fetchBiliNav({ sessdata, biliJct, uid, buvid3 }, options);
  if (!nav.ok) return { ...nav, loggedIn: false };
  if (!nav.loggedIn) {
    return { ok: false, code: 'nav_not_logged_in', error: 'Cookie 未能通过 nav 校验，未覆盖旧凭据', loggedIn: false };
  }
  await saveBiliCredentials(home, {
    sessdata,
    biliJct,
    uid: nav.uid || uid,
    uname: nav.uname,
    buvid3: buvid3 || undefined,
  });
  return { ok: true, loggedIn: true, uid: nav.uid || uid, uname: nav.uname };
}

/**
 * Unified manage entry (tool / HTTP). Never returns secrets.
 * options: fetchImpl, baseUrl, passportBaseUrl, whaleCredentialsPath, timeoutMs
 */
export async function manageBiliAuth(home, args = {}, options = {}) {
  const action = str(args.action || 'status').trim() || 'status';
  if (!BILI_AUTH_ACTIONS.includes(action)) {
    return { ok: false, error: `unknown action "${action}" (expected ${BILI_AUTH_ACTIONS.join(' | ')})` };
  }
  switch (action) {
    case 'status':
      return getBiliAuthStatus(home);
    case 'configure_cookie':
      return configureCookie(home, args, options);
    case 'qr_start':
      return startBiliQrLogin(options);
    case 'qr_poll':
      return pollBiliQrLogin(home, args, options);
    case 'import_whale':
      return importWhaleCredentials(home, options);
    case 'verify':
      return verifyBiliLogin(home, options);
    case 'clear':
      return clearBiliCredentials(home);
    default:
      return { ok: false, error: `unhandled action "${action}"` };
  }
}
