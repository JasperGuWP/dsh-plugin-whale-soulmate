// Bilibili passport QR login.
// Inspired by dsh-bili-whale 0.4.6: verify-then-atomic-write; expired/cancel never replace old creds.
// Returns an embeddable QR image (png data URL) so the panel can show a real scannable code.
import { parseBiliCookieText } from './cookie.mjs';
import { saveBiliCredentials } from './credentials.mjs';
import { fetchBiliNav } from './nav.mjs';
import { encodeQrDataUrl } from './qr-svg.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const errMsg = (err) => (err instanceof Error ? err.message : String(err));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 soulmate-bili-auth/0.1';

export const BILI_PASSPORT_BASE = 'https://passport.bilibili.com';

/** Poll `data.code` → status label. */
export function mapQrPollCode(code) {
  const n = Number(code);
  if (n === 0) return 'confirmed';
  if (n === 86101) return 'pending';
  if (n === 86090) return 'scanned';
  if (n === 86038) return 'expired';
  return 'unknown';
}

function collectSetCookies(res) {
  if (!res || !res.headers) return [];
  if (typeof res.headers.getSetCookie === 'function') {
    const list = res.headers.getSetCookie();
    if (Array.isArray(list) && list.length) return list;
  }
  const single = res.headers.get?.('set-cookie');
  if (!single) return [];
  // Some stacks join multiple Set-Cookie with comma — prefer splitting on ", <Name>="
  if (single.includes('SESSDATA=') || single.includes('bili_jct=')) {
    return single.split(/,(?=\s*[A-Za-z0-9_]+=)/);
  }
  return [single];
}

async function passportJson(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const base = str(options.passportBaseUrl || BILI_PASSPORT_BASE).replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000;
  const url = `${base}${path}`;
  const res = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      accept: 'application/json, text/plain, */*',
    },
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'} for ${path}`);
  const body = await res.json();
  return { res, body };
}

/** Start QR login → `{ ok, qrcodeKey, url, qrDataUrl }`. */
export async function startBiliQrLogin(options = {}) {
  try {
    const { body } = await passportJson('/x/passport-login/web/qrcode/generate', options);
    if (!body || body.code !== 0 || !body.data?.qrcode_key) {
      return {
        ok: false,
        code: 'generate_failed',
        error: `出码失败：code ${body?.code} ${str(body?.message || body?.msg)}`.trim(),
      };
    }
    const url = str(body.data.url);
    let qrDataUrl = '';
    try {
      qrDataUrl = await encodeQrDataUrl(url, { width: Number(options.qrWidth) > 0 ? Number(options.qrWidth) : 200 });
    } catch (err) {
      // Still return the raw URL so callers can fall back to an external renderer.
      return {
        ok: true,
        qrcodeKey: str(body.data.qrcode_key),
        url,
        qrDataUrl: '',
        expiresInSec: 180,
        qrWarn: errMsg(err),
      };
    }
    return {
      ok: true,
      qrcodeKey: str(body.data.qrcode_key),
      url,
      qrDataUrl,
      expiresInSec: 180,
    };
  } catch (err) {
    return { ok: false, code: 'generate_failed', error: errMsg(err) };
  }
}

/**
 * Poll once. On `confirmed`, nav-verify then atomic-write credentials.
 * Expired / pending / scanned never touch the disk.
 */
export async function pollBiliQrLogin(home, input = {}, options = {}) {
  const qrcodeKey = str(input.qrcodeKey || input.qrcode_key).trim();
  if (!qrcodeKey) return { ok: false, code: 'missing_key', error: '需要 qrcodeKey（来自 qr_start）' };

  let res;
  let body;
  try {
    const q = new URLSearchParams({ qrcode_key: qrcodeKey });
    ({ res, body } = await passportJson(`/x/passport-login/web/qrcode/poll?${q}`, options));
  } catch (err) {
    return { ok: false, code: 'poll_failed', error: errMsg(err) };
  }

  const data = body?.data ?? {};
  // Envelope code non-zero is rare; poll status lives in data.code.
  const pollCode = data.code !== undefined ? data.code : body?.code;
  const status = mapQrPollCode(pollCode);

  if (status !== 'confirmed') {
    return {
      ok: true,
      status,
      code: Number(pollCode),
      message: str(data.message || body?.message || ''),
    };
  }

  const parsed = parseBiliCookieText(collectSetCookies(res));
  if (!parsed.sessdata || !parsed.biliJct) {
    return {
      ok: false,
      code: 'no_cookies',
      error: '扫码成功但响应里没有 SESSDATA / bili_jct（请重试扫码）',
      status: 'confirmed',
    };
  }

  const nav = await fetchBiliNav(parsed, options);
  if (!nav.ok || !nav.loggedIn) {
    return {
      ok: false,
      code: nav.code || 'nav_not_logged_in',
      error: nav.error || '扫码 Cookie 未能通过 nav 校验，未写入凭据',
      status: 'confirmed',
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
    status: 'confirmed',
    code: 0,
    loggedIn: true,
    uid: nav.uid || parsed.uid,
    uname: nav.uname,
  };
}
