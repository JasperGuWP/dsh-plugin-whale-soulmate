// Verify a Bilibili cookie jar via /x/web-interface/nav (injectable fetch + baseUrl).
import { buildBiliCookieHeader } from './cookie.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const errMsg = (err) => (err instanceof Error ? err.message : String(err));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 soulmate-bili-auth/0.1';

/**
 * @returns {{ ok: true, loggedIn: boolean, uid: string, uname: string, face?: string } | { ok: false, code: string, error: string }}
 */
export async function fetchBiliNav(cookieOrFields, options = {}) {
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'no_fetch', error: 'no fetch implementation available' };
  }
  const cookie =
    typeof cookieOrFields === 'string'
      ? cookieOrFields
      : buildBiliCookieHeader(cookieOrFields || {});
  if (!cookie.includes('SESSDATA=')) {
    return { ok: false, code: 'no_credentials', error: '缺少 SESSDATA' };
  }
  const baseUrl = str(options.baseUrl || 'https://api.bilibili.com').replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000;
  try {
    const res = await fetchImpl(`${baseUrl}/x/web-interface/nav`, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        accept: 'application/json, text/plain, */*',
        cookie,
      },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res?.ok) return { ok: false, code: 'http_error', error: `HTTP ${res?.status ?? '?'}` };
    const body = await res.json();
    if (!body || typeof body !== 'object') return { ok: false, code: 'bad_response', error: 'nav 返回非 JSON' };
    if (body.code !== undefined && body.code !== 0) {
      return { ok: false, code: 'nav_error', error: `nav code ${body.code} ${str(body.message || body.msg)}`.trim() };
    }
    const data = body.data ?? {};
    const loggedIn = data.isLogin === true || Boolean(data.mid && data.isLogin !== false);
    const uid = data.mid != null ? String(data.mid) : '';
    const uname = str(data.uname || data.name || '');
    return {
      ok: true,
      loggedIn: Boolean(loggedIn && uid),
      uid,
      uname,
      ...(data.face ? { face: str(data.face) } : {}),
    };
  } catch (err) {
    return { ok: false, code: 'nav_failed', error: errMsg(err) };
  }
}
