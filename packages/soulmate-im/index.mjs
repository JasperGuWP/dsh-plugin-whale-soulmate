// soulmate-im: built-in multi-platform IM companion hub (Node half, zero external dependencies).
//
// Four platforms, modelled after AstrBot's adapters, all feeding the SAME Soulmate brain
// (persona + mood/affinity state machine + Hindsight x Wiki memory + 3D neural connectome):
//   1. weixin   个人微信   iLink protocol (weixin_oc): QR login + long-poll + sendmessage
//   2. qq       QQ         OneBot v11 / NapCat HTTP + webhook, or the QQ Official Bot API
//   3. feishu   飞书/Lark  tenant_access_token + Message API + event webhook (challenge handshake)
//   4. dingtalk 钉钉       sessionWebhook reply + OAuth2 accessToken + Robot OpenAPI + Stream ticket
//
// Hard rules:
//   * Tokens / secrets live ONLY in credentials.json (key `im`, mode 0600). They never enter
//     config.json, memory, tool/route output (always masked) or the audit log.
//   * Every inbound message and every outbound message passes the privacy firewall
//     (`inspectAndScrub`): a message holding a high-risk secret never enters memory.
//   * Network is injectable (`options.fetchImpl`) so everything is testable offline.
import { createHash, createHmac, createPrivateKey, randomBytes, sign as edSign, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { atomicWriteJson, loadConfig, loadCredentials, maskKey, saveConfigAuto } from '../soulmate-core/state.mjs';
import { appendPrivacyAudit, inspectAndScrub } from '../soulmate-core/privacy-firewall.mjs';
import { getDisplayName } from '../soulmate-core/persona.mjs';
import { appendImChat, listImChat, recentImBotSend } from '../soulmate-core/im-chat.mjs';

export const IM_EXTENSION_ID = 'soulmate-im';
export const IM_PLATFORMS = Object.freeze(['weixin', 'qq', 'feishu', 'dingtalk']);
export const IM_PLATFORM_LABELS = Object.freeze({ weixin: '个人微信', qq: 'QQ', feishu: '飞书', dingtalk: '钉钉' });

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const QQ_OFFICIAL_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
export const QQ_OFFICIAL_API_BASE = 'https://api.sgroup.qq.com';
export const FEISHU_DEFAULT_DOMAIN = 'https://open.feishu.cn';
export const LARK_DEFAULT_DOMAIN = 'https://open.larksuite.com';
export const DINGTALK_API_BASE = 'https://api.dingtalk.com';
export const DINGTALK_STREAM_TOPIC = '/v1.0/im/bot/messages/get';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const errMsg = (err) => (err instanceof Error ? err.message : String(err));
const trimSlash = (u) => str(u).trim().replace(/\/+$/, '');

export function normalizePlatform(input) {
  const s = str(input).trim().toLowerCase();
  if (s === 'lark') return 'feishu';
  if (s === 'wechat' || s === 'weixin_oc') return 'weixin';
  if (s === 'dingding') return 'dingtalk';
  return IM_PLATFORMS.includes(s) ? s : null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const isTimeoutError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

async function httpJson(options, url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('[soulmate-im] fetch is not available (pass options.fetchImpl)');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, options.signal]) : timeout;
  const init = { method, headers, signal };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetchImpl(url, init);
  let text = '';
  if (typeof res.text === 'function') text = await res.text();
  else if (typeof res.json === 'function') text = JSON.stringify(await res.json());
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  const status = Number(res.status) || 0;
  return { status, ok: res.ok ?? (status >= 200 && status < 300), data: isObject(data) ? data : {}, text };
}

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });
const httpFail = (label, res, detail) => ({
  ok: false,
  error: `${label} failed (HTTP ${res.status})${detail ? `: ${clip(detail, 200)}` : ''}`,
  status: res.status,
});

// ---------------------------------------------------------------------------
// Credential storage (credentials.json -> `im`, 0600)
// ---------------------------------------------------------------------------

const CRED_FIELDS = Object.freeze({
  weixin: ['token', 'accountId', 'userId', 'baseUrl', 'syncBuf', 'contextTokens'],
  qq: ['mode', 'onebotHttpUrl', 'onebotAccessToken', 'appId', 'appSecret', 'ownerId'],
  feishu: ['appId', 'appSecret', 'verificationToken', 'domain', 'ownerId'],
  dingtalk: ['clientId', 'clientSecret', 'robotCode', 'defaultWebhook', 'ownerId'],
});
const MAX_CONTEXT_TOKENS = 200;

const credQueues = new Map();
function withCredLock(path, fn) {
  const prev = credQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  credQueues.set(path, next);
  const cleanup = () => {
    if (credQueues.get(path) === next) credQueues.delete(path);
  };
  next.then(cleanup, cleanup);
  return next;
}

export function isImConfigured(platform, c = {}) {
  switch (platform) {
    case 'weixin':
      return Boolean(c.token);
    case 'qq':
      return c.mode === 'official' ? Boolean(c.appId && c.appSecret) : Boolean(c.onebotHttpUrl);
    case 'feishu':
      return Boolean(c.appId && c.appSecret);
    case 'dingtalk':
      return Boolean((c.clientId && c.clientSecret) || c.defaultWebhook);
    default:
      return false;
  }
}

/** Raw credentials of all platforms (internal use only; never hand this to a tool / route). */
export async function loadImCredentials(home) {
  const disk = await loadCredentials(home);
  const im = isObject(disk.im) ? disk.im : {};
  const out = {};
  for (const p of IM_PLATFORMS) out[p] = isObject(im[p]) ? { ...im[p] } : {};
  if (out.qq.mode !== 'official') out.qq.mode = 'onebot';
  return out;
}

/**
 * Merge `creds` into credentials.json -> im[platform] (unknown keys are ignored).
 * Returns only `{ ok, platform, configured }` — never the secrets.
 */
export async function saveImCredentials(home, platform, creds = {}) {
  const p = normalizePlatform(platform);
  if (!p) throw new Error(`[soulmate-im] unknown platform "${platform}" (expected ${IM_PLATFORMS.join(' | ')})`);
  let configured = false;
  await withCredLock(home.credentialsPath, async () => {
    const current = await loadCredentials(home);
    const im = isObject(current.im) ? { ...current.im } : {};
    const next = isObject(im[p]) ? { ...im[p] } : {};
    for (const key of CRED_FIELDS[p]) {
      const value = creds?.[key];
      if (value === undefined || value === null) continue;
      if (key === 'contextTokens') {
        if (!isObject(value)) continue;
        const merged = { ...(isObject(next.contextTokens) ? next.contextTokens : {}) };
        for (const [uid, tok] of Object.entries(value)) {
          delete merged[uid]; // re-insert => most recent last
          merged[uid] = str(tok);
        }
        const keys = Object.keys(merged);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CONTEXT_TOKENS))) delete merged[k];
        next.contextTokens = merged;
      } else {
        next[key] = str(value).trim();
      }
    }
    if (p === 'qq') next.mode = next.mode === 'official' ? 'official' : 'onebot';
    im[p] = next;
    await atomicWriteJson(home.credentialsPath, { ...current, im }, { mode: 0o600 });
    configured = isImConfigured(p, next);
  });
  return { ok: true, platform: p, configured };
}

async function loadPlatformCreds(home, platform) {
  return (await loadImCredentials(home))[platform];
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return u ? '(invalid url)' : '';
  }
};

/** Masked, secret-free status of all platforms (safe for tools / HTTP routes). */
export async function getImStatus(home) {
  const [conf, creds] = await Promise.all([loadConfig(home), loadImCredentials(home)]);
  const plat = (p) => ({ enabled: conf.extensions?.imPlatforms?.[p]?.enabled === true, configured: isImConfigured(p, creds[p]) });
  // The official QQ open-platform bot is a SEPARATE channel from these built-in IM
  // platforms. Without this note the model reads "all off" and tells the user it cannot
  // send anything — while it is literally replying through the official bot right now.
  let officialQqBot = { bound: false };
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const patch = await readFile(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    const block = patch.slice(patch.indexOf('- id: im-qqbot'));
    const appId = /appId:\s*"?(\d+)"?/.exec(block)?.[1] || '';
    officialQqBot = { bound: Boolean(appId), appId: appId ? appId.slice(0, 4) + '…' : '' };
  } catch { /* no profile patch */ }
  return {
    ok: true,
    note: '这里只列 soulmate 内置 IM 通道。QQ 官方开放平台 Bot 是独立通道（见 officialQqBot），它绑定着就能在 QQ 私聊/群里对话；其主动发消息受平台被动窗口限制（群5分钟/私聊30分钟）。内置通道全关 ≠ QQ 不能说话。',
    officialQqBot,
    imProactive: {
      enabled: conf.extensions?.imProactiveEnabled === true,
      whitelist: Array.isArray(conf.extensions?.imProactiveWhitelist) ? conf.extensions.imProactiveWhitelist.length : 0,
    },
    imEnabled: conf.extensions?.imEnabled !== false,
    whitelist: Array.isArray(conf.extensions?.imWhitelist) ? conf.extensions.imWhitelist : [],
    platforms: {
      weixin: {
        ...plat('weixin'),
        label: IM_PLATFORM_LABELS.weixin,
        accountId: maskKey(creds.weixin.accountId),
        userId: maskKey(creds.weixin.userId),
        tokenMasked: maskKey(creds.weixin.token),
        baseUrl: originOf(creds.weixin.baseUrl || WEIXIN_DEFAULT_BASE_URL),
        hasSyncBuf: Boolean(creds.weixin.syncBuf),
        knownContacts: Object.keys(isObject(creds.weixin.contextTokens) ? creds.weixin.contextTokens : {}).length,
      },
      qq: {
        ...plat('qq'),
        label: IM_PLATFORM_LABELS.qq,
        mode: creds.qq.mode,
        onebotHttpUrl: originOf(creds.qq.onebotHttpUrl),
        hasAccessToken: Boolean(creds.qq.onebotAccessToken),
        appId: maskKey(creds.qq.appId),
        hasAppSecret: Boolean(creds.qq.appSecret),
        hasOwnerId: Boolean(creds.qq.ownerId),
      },
      feishu: {
        ...plat('feishu'),
        label: IM_PLATFORM_LABELS.feishu,
        appId: maskKey(creds.feishu.appId),
        hasAppSecret: Boolean(creds.feishu.appSecret),
        hasVerificationToken: Boolean(creds.feishu.verificationToken),
        domain: feishuBase(creds.feishu.domain),
        hasOwnerId: Boolean(creds.feishu.ownerId),
      },
      dingtalk: {
        ...plat('dingtalk'),
        label: IM_PLATFORM_LABELS.dingtalk,
        clientId: maskKey(creds.dingtalk.clientId),
        hasClientSecret: Boolean(creds.dingtalk.clientSecret),
        robotCode: maskKey(creds.dingtalk.robotCode),
        hasDefaultWebhook: Boolean(creds.dingtalk.defaultWebhook),
        hasOwnerId: Boolean(creds.dingtalk.ownerId),
      },
    },
  };
}

async function setPlatformEnabled(home, platform, enabled, extra = {}) {
  await saveConfigAuto(home, { extensions: { imPlatforms: { [platform]: { enabled: enabled === true, ...extra } } } });
}

async function isPlatformActive(home, platform) {
  const conf = await loadConfig(home);
  return conf.extensions?.imEnabled !== false && conf.extensions?.imPlatforms?.[platform]?.enabled === true;
}

// short-lived access-token caches (in memory only, never persisted)
const tokenCache = new Map();
export function clearImTokenCache() {
  tokenCache.clear();
}
async function cachedToken(key, fetcher) {
  const hit = tokenCache.get(key);
  if (hit && hit.expireAt > Date.now()) return hit.token;
  const { token, ttlSec } = await fetcher();
  const ttl = Math.max(60, Number(ttlSec) || 3600);
  tokenCache.set(key, { token, expireAt: Date.now() + (ttl - 60) * 1000 });
  return token;
}

const safeEq = (a, b) => {
  const ha = createHash('sha256').update(str(a)).digest();
  const hb = createHash('sha256').update(str(b)).digest();
  return timingSafeEqual(ha, hb);
};
const hget = (headers, name) => {
  if (!isObject(headers)) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return str(Array.isArray(v) ? v[0] : v);
  return '';
};

// ---------------------------------------------------------------------------
// Platform 1: 个人微信 (iLink protocol, modelled on AstrBot weixin_oc)
// ---------------------------------------------------------------------------

const weixinHeaders = (token, extra = {}) => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...extra,
});
const weixinRetFail = (data) => {
  const ret = Number(data?.ret ?? 0);
  const code = Number(data?.errcode ?? 0);
  return ret !== 0 || code !== 0 ? { ret, errcode: code, message: str(data?.errmsg) } : null;
};

export async function startWeixinQrLogin(home, options = {}) {
  const base = trimSlash(options.baseUrl) || WEIXIN_DEFAULT_BASE_URL;
  try {
    const res = await httpJson(options, `${base}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: weixinHeaders('') });
    if (!res.ok) return httpFail('weixin get_bot_qrcode', res);
    if (!res.data.qrcode) return { ok: false, error: 'weixin get_bot_qrcode returned no qrcode' };
    const qrcode = str(res.data.qrcode);
    const qrcodeImgContent = str(res.data.qrcode_img_content);
    const encodeText = qrcodeImgContent || qrcode;
    let qrDataUrl = '';
    try {
      const width = Number(options.qrWidth) > 0 ? Number(options.qrWidth) : 200;
      qrDataUrl = await QRCode.toDataURL(encodeText, {
        margin: 2,
        width,
        errorCorrectionLevel: 'M',
        color: { dark: '#111111', light: '#ffffff' },
      });
    } catch {
      qrDataUrl = '';
    }
    return {
      ok: true,
      qrcode,
      qrcodeImgContent,
      qrDataUrl,
      pollIntervalSec: 1,
    };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** Clear WeChat iLink credentials and disable the platform (official logout). */
export async function logoutWeixin(home) {
  await withCredLock(home.credentialsPath, async () => {
    const current = await loadCredentials(home);
    const im = isObject(current.im) ? { ...current.im } : {};
    im.weixin = {};
    await atomicWriteJson(home.credentialsPath, { ...current, im }, { mode: 0o600 });
  });
  await setPlatformEnabled(home, 'weixin', false);
  await appendPrivacyAudit(home, { action: 'im_logout', platform: 'weixin' });
  return getImStatus(home);
}

export async function pollWeixinQrStatus(home, qrcode, options = {}) {
  const base = trimSlash(options.baseUrl) || WEIXIN_DEFAULT_BASE_URL;
  if (!str(qrcode).trim()) return { ok: false, error: 'qrcode is required' };
  try {
    const res = await httpJson(options, `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: weixinHeaders('', { 'iLink-App-ClientVersion': '1' }),
      timeoutMs: options.timeoutMs ?? 40_000,
    });
    if (!res.ok) return httpFail('weixin get_qrcode_status', res);
    const status = str(res.data.status).toLowerCase() || 'wait';
    if (status !== 'confirmed') return { ok: true, status };
    const token = str(res.data.bot_token);
    if (!token) return { ok: false, status, error: 'weixin login confirmed but no bot_token was returned' };
    await saveImCredentials(home, 'weixin', {
      token,
      accountId: str(res.data.ilink_bot_id),
      userId: str(res.data.ilink_user_id),
      baseUrl: trimSlash(res.data.baseurl) || base,
      syncBuf: '',
    });
    await setPlatformEnabled(home, 'weixin', true);
    await appendPrivacyAudit(home, { action: 'im_login_confirmed', platform: 'weixin' });
    return {
      ok: true,
      status: 'confirmed',
      accountId: str(res.data.ilink_bot_id),
      userId: str(res.data.ilink_user_id),
      tokenMasked: maskKey(token),
    };
  } catch (err) {
    if (isTimeoutError(err)) return { ok: true, status: 'wait' };
    return { ok: false, error: errMsg(err) };
  }
}

function weixinMessageText(msg) {
  const parts = [];
  for (const item of Array.isArray(msg?.item_list) ? msg.item_list : []) {
    if (item?.type === 1 && item.text_item?.text) parts.push(str(item.text_item.text));
    else if (item?.type === 3 && item.voice_item?.text) parts.push(str(item.voice_item.text)); // voice -> server-side transcript
  }
  return parts.join('\n').trim();
}

export async function pollWeixinUpdatesOnce(soulmateService, options = {}) {
  const home = soulmateService.home;
  const creds = await loadPlatformCreds(home, 'weixin');
  if (!creds.token) return { ok: false, error: 'weixin is not logged in (no token)' };
  const base = trimSlash(options.baseUrl ?? creds.baseUrl) || WEIXIN_DEFAULT_BASE_URL;
  let res;
  try {
    res = await httpJson(options, `${base}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: weixinHeaders(creds.token),
      body: { base_info: { channel_version: 'dsh-soulmate' }, get_updates_buf: str(creds.syncBuf) },
      timeoutMs: options.timeoutMs ?? 40_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) return { ok: true, received: 0, handled: 0, timeout: true, results: [] };
    return { ok: false, error: errMsg(err) };
  }
  if (!res.ok) return httpFail('weixin getupdates', res);
  const fail = weixinRetFail(res.data);
  if (fail) {
    return { ok: false, error: `weixin getupdates error ret=${fail.ret} errcode=${fail.errcode} ${clip(fail.message, 120)}`.trim(), errcode: fail.errcode, sessionExpired: fail.errcode === -14 };
  }

  const msgs = (Array.isArray(res.data.msgs) ? res.data.msgs : []).filter((m) => m && m.message_type !== 2); // 2 = bot's own
  const contextTokens = {};
  for (const m of msgs) if (m.from_user_id && m.context_token) contextTokens[str(m.from_user_id)] = str(m.context_token);
  // persist cursor + context tokens BEFORE handling, so a crash never replays messages
  await saveImCredentials(home, 'weixin', {
    ...(typeof res.data.get_updates_buf === 'string' ? { syncBuf: res.data.get_updates_buf } : {}),
    ...(Object.keys(contextTokens).length ? { contextTokens } : {}),
  });

  const results = [];
  for (const m of msgs) {
    const text = weixinMessageText(m);
    const senderId = str(m.from_user_id);
    if (!text || !senderId) continue;
    results.push(
      await handleInboundImMessage(
        soulmateService,
        { platform: 'weixin', senderId, senderName: senderId, text, contextToken: str(m.context_token), messageId: str(m.message_id ?? m.client_id) },
        options
      )
    );
  }
  return { ok: true, received: msgs.length, handled: results.length, results };
}

export async function sendWeixinMessage(home, { toUserId, text, contextToken } = {}, options = {}) {
  const creds = await loadPlatformCreds(home, 'weixin');
  if (!creds.token) return { ok: false, error: 'weixin is not logged in (no token)' };
  const to = str(toUserId || creds.userId).trim();
  if (!to) return { ok: false, error: 'toUserId is required' };
  if (!str(text).trim()) return { ok: false, error: 'text is required' };
  const base = trimSlash(options.baseUrl ?? creds.baseUrl) || WEIXIN_DEFAULT_BASE_URL;
  const savedToken = isObject(creds.contextTokens) ? creds.contextTokens[to] : '';
  const token = str(contextToken || savedToken);
  // iLink requires a fresh context_token from an inbound user message; cold proactive
  // sends without one always come back ret=-2 "prepare failed".
  if (!token) {
    return {
      ok: false,
      error: '微信官方 Bot 不能冷启动私聊：请先用手机微信给 Bot 发一条，拿到会话票（context_token）后再回/试发。',
      needInbound: true,
    };
  }
  const clientId = randomBytes(16).toString('hex');
  try {
    const res = await httpJson(options, `${base}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: weixinHeaders(creds.token),
      body: {
        base_info: { channel_version: 'dsh-soulmate' },
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: token,
          item_list: [{ type: 1, text_item: { text: clip(str(text), 2000) } }],
        },
      },
    });
    if (!res.ok) return httpFail('weixin sendmessage', res);
    const fail = weixinRetFail(res.data);
    if (fail) {
      const hint =
        fail.ret === -2 && /prepare failed/i.test(fail.message || '')
          ? '（会话票失效或缺失：请让对方再发一条微信，然后尽快回复；官方通道不支持无票主动私聊）'
          : '';
      return {
        ok: false,
        error: `weixin sendmessage error ret=${fail.ret} errcode=${fail.errcode} ${clip(fail.message, 120)}${hint}`.trim(),
        needInbound: fail.ret === -2,
      };
    }
    return { ok: true, platform: 'weixin', clientId };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** Opt-in background long-poll loop. Returns a `stop()` function. */
export function startWeixinPollLoop(soulmateService, options = {}) {
  const ac = new AbortController();
  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const home = soulmateService.home;
        const creds = await loadPlatformCreds(home, 'weixin');
        if (!creds.token || !(await isPlatformActive(home, 'weixin'))) {
          await sleep(options.idleMs ?? 5000);
          continue;
        }
        const res = await pollWeixinUpdatesOnce(soulmateService, { ...options, signal: ac.signal });
        if (!res.ok) {
          options.onError?.(res.error);
          await sleep(options.errorBackoffMs ?? 5000);
        }
      } catch (err) {
        if (ac.signal.aborted) break;
        options.onError?.(errMsg(err));
        await sleep(options.errorBackoffMs ?? 5000);
      }
    }
  })();
  return () => ac.abort();
}

// ---------------------------------------------------------------------------
// Platform 2: QQ (OneBot v11 / NapCat + QQ Official Bot)
// ---------------------------------------------------------------------------

const idValue = (v) => {
  const s = str(v).trim();
  return /^\d{1,15}$/.test(s) ? Number(s) : s;
};

export async function sendQqMessage(home, { userId, groupId, text, msgId } = {}, options = {}) {
  const creds = await loadPlatformCreds(home, 'qq');
  const body = str(text);
  if (!body.trim()) return { ok: false, error: 'text is required' };
  const target = str(groupId).trim() ? { group: str(groupId).trim() } : { user: str(userId || creds.ownerId).trim() };
  if (!target.group && !target.user) return { ok: false, error: 'userId or groupId is required' };

  try {
    if (creds.mode === 'official') {
      if (!(creds.appId && creds.appSecret)) return { ok: false, error: 'qq official bot is not configured (appId/appSecret)' };
      const token = await qqOfficialToken(creds, options);
      const base = trimSlash(options.qqApiBase) || QQ_OFFICIAL_API_BASE;
      const url = target.group
        ? `${base}/v2/groups/${encodeURIComponent(target.group)}/messages`
        : `${base}/v2/users/${encodeURIComponent(target.user)}/messages`;
      const res = await httpJson(options, url, {
        method: 'POST',
        headers: jsonHeaders({ Authorization: `QQBot ${token}`, 'X-Union-Appid': creds.appId }),
        body: { content: clip(body, 2000), msg_type: 0, ...(msgId ? { msg_id: str(msgId) } : {}) },
      });
      if (!res.ok || (res.data.code && !res.data.id)) return httpFail('qq official send', res, res.data.message);
      return { ok: true, platform: 'qq', mode: 'official', messageId: str(res.data.id) };
    }

    if (!creds.onebotHttpUrl) return { ok: false, error: 'qq onebot is not configured (onebotHttpUrl)' };
    const base = trimSlash(creds.onebotHttpUrl);
    const res = await httpJson(options, `${base}/${target.group ? 'send_group_msg' : 'send_private_msg'}`, {
      method: 'POST',
      headers: jsonHeaders(creds.onebotAccessToken ? { Authorization: `Bearer ${creds.onebotAccessToken}` } : {}),
      body: target.group
        ? { group_id: idValue(target.group), message: clip(body, 4500) }
        : { user_id: idValue(target.user), message: clip(body, 4500) },
    });
    if (!res.ok) return httpFail('qq onebot send', res);
    if ((res.data.status && res.data.status !== 'ok') || (res.data.retcode !== undefined && Number(res.data.retcode) !== 0)) {
      return { ok: false, error: `qq onebot send rejected (retcode ${res.data.retcode})` };
    }
    return { ok: true, platform: 'qq', mode: 'onebot', messageId: str(res.data.data?.message_id) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

async function qqOfficialToken(creds, options) {
  return cachedToken(`qq:${creds.appId}`, async () => {
    const res = await httpJson(options, trimSlash(options.qqTokenUrl) || QQ_OFFICIAL_TOKEN_URL, {
      method: 'POST',
      headers: jsonHeaders(),
      body: { appId: creds.appId, clientSecret: creds.appSecret },
    });
    if (!res.ok || !res.data.access_token) throw new Error(`qq official token exchange failed (HTTP ${res.status})`);
    return { token: str(res.data.access_token), ttlSec: Number(res.data.expires_in) };
  });
}

const decodeCq = (s) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');

function onebotRawText(body) {
  if (typeof body.raw_message === 'string' && body.raw_message) return body.raw_message;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) {
    return body.message
      .map((seg) => {
        if (seg?.type === 'text') return str(seg.data?.text);
        if (seg?.type === 'at') return `[CQ:at,qq=${str(seg.data?.qq)}]`;
        return '';
      })
      .join('');
  }
  return '';
}

/** Parse a OneBot v11 event. Returns a normalized inbound event, or null when it should be ignored. */
export function parseOneBotEvent(body, options = {}) {
  if (!isObject(body) || body.post_type !== 'message') return null;
  const kind = body.message_type;
  if (kind !== 'private' && kind !== 'group') return null;
  const senderId = str(body.user_id ?? body.sender?.user_id).trim();
  if (!senderId) return null;
  const selfId = str(options.selfId ?? body.self_id).trim();
  if (selfId && senderId === selfId) return null;

  const raw = onebotRawText(body);
  let mentioned = false;
  if (selfId) {
    if (Array.isArray(body.message)) mentioned = body.message.some((seg) => seg?.type === 'at' && str(seg.data?.qq) === selfId);
    mentioned = mentioned || raw.includes(`[CQ:at,qq=${selfId}]`);
  }
  if (kind === 'group' && options.requireMention !== false && !mentioned) return null;

  const text = decodeCq(raw.replace(/\[CQ:[^\]]*\]/g, '')).trim();
  if (!text) return null;
  const groupId = kind === 'group' && body.group_id !== undefined ? str(body.group_id) : '';
  return {
    platform: 'qq',
    mode: 'onebot',
    senderId,
    groupId,
    senderName: str(body.sender?.card || body.sender?.nickname),
    text,
    messageId: str(body.message_id ?? ''),
    isMention: mentioned,
  };
}

/** QQ Official Bot webhook (op 0 dispatch) -> inbound event, or null. */
export function parseQqOfficialEvent(body) {
  if (!isObject(body) || body.op !== 0 || !isObject(body.d)) return null;
  const d = body.d;
  const text = str(d.content).trim();
  if (!text) return null;
  if (body.t === 'C2C_MESSAGE_CREATE') {
    return { platform: 'qq', mode: 'official', senderId: str(d.author?.user_openid), groupId: '', senderName: '', text, messageId: str(d.id) };
  }
  if (body.t === 'GROUP_AT_MESSAGE_CREATE') {
    return { platform: 'qq', mode: 'official', senderId: str(d.author?.member_openid), groupId: str(d.group_openid), senderName: '', text, messageId: str(d.id), isMention: true };
  }
  return null;
}

/** Ed25519 signature for the QQ Official webhook callback validation (op 13). */
export function signQqValidation(appSecret, plainToken, eventTs) {
  let seed = str(appSecret);
  if (!seed) throw new Error('appSecret is required');
  while (seed.length < 32) seed += seed;
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed.slice(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return edSign(null, Buffer.from(str(eventTs) + str(plainToken)), key).toString('hex');
}

export async function handleQqWebhook(soulmateService, body, options = {}) {
  const home = soulmateService.home;
  const creds = await loadPlatformCreds(home, 'qq');
  if (isObject(body) && body.op === 13 && isObject(body.d)) {
    if (!creds.appSecret) return { ok: false, status: 400, error: 'qq official appSecret is not configured' };
    const plainToken = str(body.d.plain_token);
    return { ok: true, status: 200, response: { plain_token: plainToken, signature: signQqValidation(creds.appSecret, plainToken, body.d.event_ts) } };
  }
  if (!(await isPlatformActive(home, 'qq'))) return { ok: false, status: 403, error: 'qq channel is disabled' };
  if (creds.onebotAccessToken) {
    const auth = hget(options.headers, 'authorization').replace(/^(Bearer|Token)\s+/i, '');
    if (!auth || !safeEq(auth, creds.onebotAccessToken)) return { ok: false, status: 403, error: 'access token mismatch' };
  }
  const event = parseQqOfficialEvent(body) ?? parseOneBotEvent(body, options);
  if (!event) return { ok: true, status: 200, ignored: true, response: {} };
  const result = await handleInboundImMessage(soulmateService, event, options);
  const quick = !result.dispatched?.ok && result.reply && event.mode === 'onebot' && !creds.onebotHttpUrl ? { reply: result.reply } : {};
  return { ok: result.ok !== false, status: 200, response: quick, result };
}

// ---------------------------------------------------------------------------
// Platform 3: 飞书 / Lark
// ---------------------------------------------------------------------------

export function feishuBase(domain) {
  const d = str(domain).trim();
  if (!d || d.toLowerCase() === 'feishu') return FEISHU_DEFAULT_DOMAIN;
  if (d.toLowerCase() === 'lark') return LARK_DEFAULT_DOMAIN;
  return /^https?:\/\//i.test(d) ? trimSlash(d) : `https://${trimSlash(d)}`;
}

async function feishuTenantToken(creds, options) {
  const base = feishuBase(options.domain ?? creds.domain);
  return cachedToken(`feishu:${base}:${creds.appId}`, async () => {
    const res = await httpJson(options, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: { app_id: creds.appId, app_secret: creds.appSecret },
    });
    if (!res.ok || Number(res.data.code) !== 0 || !res.data.tenant_access_token) {
      throw new Error(`feishu tenant_access_token failed (HTTP ${res.status}, code ${res.data.code ?? '?'})`);
    }
    return { token: str(res.data.tenant_access_token), ttlSec: Number(res.data.expire) };
  });
}

export async function sendFeishuMessage(home, { receiveId, receiveIdType = 'open_id', text, replyToMessageId } = {}, options = {}) {
  const creds = await loadPlatformCreds(home, 'feishu');
  if (!(creds.appId && creds.appSecret)) return { ok: false, error: 'feishu is not configured (appId/appSecret)' };
  if (!str(text).trim()) return { ok: false, error: 'text is required' };
  const to = str(receiveId || creds.ownerId).trim();
  if (!replyToMessageId && !to) return { ok: false, error: 'receiveId or replyToMessageId is required' };
  try {
    const token = await feishuTenantToken(creds, options);
    const base = feishuBase(options.domain ?? creds.domain);
    const url = replyToMessageId
      ? `${base}/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
      : `${base}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
    const payload = { msg_type: 'text', content: JSON.stringify({ text: clip(str(text), 4000) }) };
    const res = await httpJson(options, url, {
      method: 'POST',
      headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
      body: replyToMessageId ? payload : { receive_id: to, ...payload },
    });
    if (!res.ok || Number(res.data.code ?? 0) !== 0) return httpFail('feishu send', res, res.data.msg);
    return { ok: true, platform: 'feishu', messageId: str(res.data.data?.message_id) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

const seenEvents = new Map();
function seenBefore(key) {
  if (!key) return false;
  if (seenEvents.has(key)) return true;
  seenEvents.set(key, Date.now());
  if (seenEvents.size > 500) seenEvents.delete(seenEvents.keys().next().value);
  return false;
}
export function clearImEventDedupe() {
  seenEvents.clear();
}

/** Feishu event subscription endpoint. Returns `{ ok, status, response, ... }`. */
export async function handleFeishuWebhook(soulmateService, body, options = {}) {
  const home = soulmateService.home;
  if (!isObject(body)) return { ok: false, status: 400, error: 'invalid body' };
  // URL verification handshake: answer immediately (the console sends it before anything is enabled).
  if (body.type === 'url_verification' || body.challenge) {
    return { ok: true, status: 200, challenge: body.challenge, response: { challenge: body.challenge } };
  }
  const creds = await loadPlatformCreds(home, 'feishu');
  if (!creds.verificationToken) {
    return { ok: false, status: 403, error: 'feishu verificationToken is not configured; set it before accepting events' };
  }
  const got = str(body.header?.token ?? body.token);
  if (!got || !safeEq(got, creds.verificationToken)) return { ok: false, status: 403, error: 'verification token mismatch' };
  if (body.encrypt) {
    return { ok: false, status: 400, error: 'encrypted feishu events are not supported; clear the Encrypt Key in the developer console' };
  }
  if (!(await isPlatformActive(home, 'feishu'))) return { ok: false, status: 403, error: 'feishu channel is disabled' };

  const header = isObject(body.header) ? body.header : {};
  const event = isObject(body.event) ? body.event : {};
  if (header.event_type !== 'im.message.receive_v1') return { ok: true, status: 200, ignored: true, response: { code: 0 } };
  const msg = isObject(event.message) ? event.message : {};
  if (msg.message_type && msg.message_type !== 'text') return { ok: true, status: 200, ignored: true, response: { code: 0 } };
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') return { ok: true, status: 200, ignored: true, response: { code: 0 } };
  const group = msg.chat_type === 'group';
  if (group && !(Array.isArray(msg.mentions) && msg.mentions.length)) return { ok: true, status: 200, ignored: true, response: { code: 0 } };
  if (seenBefore(`feishu:${header.event_id || msg.message_id}`)) return { ok: true, status: 200, duplicate: true, response: { code: 0 } };

  let content = {};
  try {
    content = JSON.parse(str(msg.content));
  } catch {
    content = {};
  }
  const text = str(content.text).replace(/@_user_\d+/g, '').trim();
  const senderId = str(event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id);
  if (!text || !senderId) return { ok: true, status: 200, ignored: true, response: { code: 0 } };

  const result = await handleInboundImMessage(
    soulmateService,
    { platform: 'feishu', senderId, senderName: senderId, groupId: group ? str(msg.chat_id) : '', text, messageId: str(msg.message_id) },
    options
  );
  return { ok: result.ok !== false, status: 200, response: { code: 0 }, result };
}

// ---------------------------------------------------------------------------
// Platform 4: 钉钉
// ---------------------------------------------------------------------------

/** SSRF guard: a sessionWebhook comes from untrusted payloads, only DingTalk hosts are allowed. */
export function isSafeDingtalkWebhook(url, options = {}) {
  try {
    const u = new URL(url);
    if (options.allowAnyWebhookHost === true) return /^https?:$/.test(u.protocol);
    return u.protocol === 'https:' && (u.hostname === 'dingtalk.com' || u.hostname.endsWith('.dingtalk.com'));
  } catch {
    return false;
  }
}

async function dingtalkAccessToken(creds, options) {
  const base = trimSlash(options.dingtalkApiBase) || DINGTALK_API_BASE;
  return cachedToken(`dingtalk:${creds.clientId}`, async () => {
    const res = await httpJson(options, `${base}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: { appKey: creds.clientId, appSecret: creds.clientSecret },
    });
    if (!res.ok || !res.data.accessToken) throw new Error(`dingtalk accessToken failed (HTTP ${res.status})`);
    return { token: str(res.data.accessToken), ttlSec: Number(res.data.expireIn) };
  });
}

export async function sendDingtalkMessage(home, { sessionWebhook, userIds, openConversationId, text, title } = {}, options = {}) {
  const creds = await loadPlatformCreds(home, 'dingtalk');
  if (!str(text).trim()) return { ok: false, error: 'text is required' };
  const content = clip(str(text), 4000);
  const users = (Array.isArray(userIds) ? userIds : userIds ? [userIds] : []).map(str).filter(Boolean);
  const proactive = users.length > 0 || Boolean(openConversationId);

  try {
    // Mode A: reply through a sessionWebhook (or the configured default webhook)
    const webhook = str(sessionWebhook) || (!proactive ? creds.defaultWebhook : '');
    if (webhook) {
      if (!isSafeDingtalkWebhook(webhook, options)) return { ok: false, error: 'refusing to post to a non-DingTalk webhook url' };
      const res = await httpJson(options, webhook, {
        method: 'POST',
        headers: jsonHeaders(),
        body: title
          ? { msgtype: 'markdown', markdown: { title: str(title), text: content } }
          : { msgtype: 'text', text: { content } },
      });
      if (!res.ok || (res.data.errcode !== undefined && Number(res.data.errcode) !== 0)) return httpFail('dingtalk webhook send', res, res.data.errmsg);
      return { ok: true, platform: 'dingtalk', via: 'webhook' };
    }

    // Mode B: proactive Robot OpenAPI send
    if (!(creds.clientId && creds.clientSecret && creds.robotCode)) {
      return { ok: false, error: 'dingtalk openapi is not configured (clientId/clientSecret/robotCode)' };
    }
    if (!proactive) return { ok: false, error: 'userIds, openConversationId or a sessionWebhook is required' };
    const token = await dingtalkAccessToken(creds, options);
    const base = trimSlash(options.dingtalkApiBase) || DINGTALK_API_BASE;
    const msgKey = title ? 'sampleMarkdown' : 'sampleText';
    const msgParam = JSON.stringify(title ? { title: str(title), text: content } : { content });
    const url = users.length ? `${base}/v1.0/robot/oToMessages/batchSend` : `${base}/v1.0/robot/groupMessages/send`;
    const res = await httpJson(options, url, {
      method: 'POST',
      headers: jsonHeaders({ 'x-acs-dingtalk-access-token': token }),
      body: users.length
        ? { robotCode: creds.robotCode, userIds: users, msgKey, msgParam }
        : { robotCode: creds.robotCode, openConversationId: str(openConversationId), msgKey, msgParam },
    });
    if (!res.ok || res.data.code) return httpFail('dingtalk openapi send', res, res.data.message);
    return { ok: true, platform: 'dingtalk', via: 'openapi', processQueryKey: str(res.data.processQueryKey) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** Negotiate a Stream gateway ticket (the caller opens the websocket itself). */
export async function openDingtalkStreamTicket(home, options = {}) {
  const creds = await loadPlatformCreds(home, 'dingtalk');
  if (!(creds.clientId && creds.clientSecret)) return { ok: false, error: 'dingtalk is not configured (clientId/clientSecret)' };
  const base = trimSlash(options.dingtalkApiBase) || DINGTALK_API_BASE;
  try {
    const res = await httpJson(options, `${base}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_STREAM_TOPIC }],
      },
    });
    if (!res.ok || !res.data.endpoint || !res.data.ticket) return httpFail('dingtalk stream open', res, res.data.message);
    return { ok: true, endpoint: str(res.data.endpoint), ticket: str(res.data.ticket) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

function verifyDingtalkSignature(headers, secret, { allowUnsigned = false } = {}) {
  const sign = hget(headers, 'sign');
  // Unsigned callbacks are rejected unless explicitly opted in (e.g. a trusted Stream relay).
  if (!sign) return allowUnsigned;
  const timestamp = hget(headers, 'timestamp');
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 3_600_000) return false;
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  return safeEq(sign, expected);
}

/** DingTalk chatbot callback (HTTP outgoing / Stream relay). Replies through the sessionWebhook. */
export async function handleDingtalkWebhook(soulmateService, body, options = {}) {
  const home = soulmateService.home;
  if (!isObject(body)) return { ok: false, status: 400, error: 'invalid body' };
  const creds = await loadPlatformCreds(home, 'dingtalk');
  if (!verifyDingtalkSignature(options.headers, creds.clientSecret, { allowUnsigned: options.allowUnsignedDingtalk === true })) {
    return { ok: false, status: 403, error: 'signature missing or mismatch' };
  }
  if (!(await isPlatformActive(home, 'dingtalk'))) return { ok: false, status: 403, error: 'dingtalk channel is disabled' };

  const text = str(body.text?.content).trim();
  const senderId = str(body.senderStaffId || body.senderId).trim();
  if ((body.msgtype && body.msgtype !== 'text') || !text || !senderId) return { ok: true, status: 200, ignored: true, response: {} };
  if (seenBefore(`dingtalk:${body.msgId}`)) return { ok: true, status: 200, duplicate: true, response: {} };

  const expiresAt = Number(body.sessionWebhookExpiredTime);
  const sessionWebhook = body.sessionWebhook && !(Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) ? str(body.sessionWebhook) : '';
  const result = await handleInboundImMessage(
    soulmateService,
    {
      platform: 'dingtalk',
      senderId,
      senderName: str(body.senderNick),
      groupId: str(body.conversationType) === '2' ? str(body.conversationId) : '',
      text,
      messageId: str(body.msgId),
      sessionWebhook,
      conversationType: str(body.conversationType),
    },
    options
  );
  return { ok: result.ok !== false, status: 200, response: {}, result };
}

// ---------------------------------------------------------------------------
// Unified outbound
// ---------------------------------------------------------------------------

/**
 * Send one message through any platform after passing the privacy firewall.
 * params: { text, to, groupId, receiveIdType, replyToMessageId, sessionWebhook, contextToken,
 *           openConversationId, title, msgId }
 */
export async function sendImMessage(home, platform, params = {}, options = {}) {
  const p = normalizePlatform(platform);
  if (!p) return { ok: false, error: `unknown platform "${platform}" (expected ${IM_PLATFORMS.join(' | ')})` };
  const checked = inspectAndScrub(str(params.text));
  if (!checked.allowed) {
    await appendPrivacyAudit(home, { action: 'im_send_blocked', platform: p, reason: checked.blockedReason });
    return { ok: false, blockedReason: checked.blockedReason, error: `消息被隐私防火墙拦截：${checked.blockedReason}` };
  }
  const text = checked.scrubbedText;
  const to = str(params.to).trim();
  let res;
  switch (p) {
    case 'weixin':
      res = await sendWeixinMessage(home, { toUserId: to, text, contextToken: params.contextToken }, options);
      break;
    case 'qq':
      res = await sendQqMessage(home, { userId: to, groupId: params.groupId, text, msgId: params.msgId }, options);
      break;
    case 'feishu':
      res = await sendFeishuMessage(
        home,
        { receiveId: to, receiveIdType: params.receiveIdType || 'open_id', text, replyToMessageId: params.replyToMessageId },
        options
      );
      break;
    case 'dingtalk': {
      const creds = await loadPlatformCreds(home, 'dingtalk');
      const target = to || creds.ownerId;
      res = await sendDingtalkMessage(
        home,
        {
          sessionWebhook: params.sessionWebhook,
          userIds: target ? [target] : undefined,
          openConversationId: params.openConversationId,
          text,
          title: params.title,
        },
        options
      );
      break;
    }
    default:
      return { ok: false, error: 'unsupported platform' };
  }
  if (res?.ok && options.skipChatLog !== true) {
    const peerId = to
      || (p === 'weixin' ? str((await loadPlatformCreds(home, 'weixin')).userId) : '')
      || (p === 'dingtalk' ? str((await loadPlatformCreds(home, 'dingtalk')).ownerId) : '')
      || str(params.groupId);
    if (peerId) {
      await appendImChat(home, {
        platform: p,
        peerId,
        peerLabel: peerId,
        role: 'bot',
        text,
      }).catch(() => {});
    }
  }
  return res;
}

async function dispatchReply(home, event, text, options) {
  const p = event.platform;
  const creds = await loadPlatformCreds(home, p);
  // Timeline already records the bot line in handleInboundImMessage.
  const opts = { ...options, skipChatLog: true };
  switch (p) {
    case 'weixin':
      if (!creds.token) return { ok: false, skipped: 'no_credentials' };
      return sendImMessage(home, 'weixin', { text, to: event.senderId, contextToken: event.contextToken }, opts);
    case 'qq':
      if (!isImConfigured('qq', creds)) return { ok: false, skipped: 'no_credentials' };
      return sendImMessage(home, 'qq', { text, to: event.senderId, groupId: event.groupId, msgId: event.messageId }, opts);
    case 'feishu':
      if (!isImConfigured('feishu', creds)) return { ok: false, skipped: 'no_credentials' };
      return sendImMessage(home, 'feishu', event.messageId ? { text, replyToMessageId: event.messageId } : { text, to: event.senderId }, opts);
    case 'dingtalk': {
      const usable = event.sessionWebhook && isSafeDingtalkWebhook(event.sessionWebhook, opts);
      if (!usable && !(creds.clientId && creds.clientSecret && creds.robotCode)) return { ok: false, skipped: 'no_credentials' };
      return sendImMessage(
        home,
        'dingtalk',
        usable ? { text, sessionWebhook: event.sessionWebhook } : { text, to: event.senderId },
        opts
      );
    }
    default:
      return { ok: false, skipped: 'unknown_platform' };
  }
}

// ---------------------------------------------------------------------------
// Unified Soulmate brain & memory bridge
// ---------------------------------------------------------------------------

const MAX_INBOUND_CHARS = 2000;
const DIGEST_LINES = 5;
const digests = new Map();

const whitelistHit = (list, event) => {
  const candidates = [event.senderId, `${event.platform}:${event.senderId}`];
  if (event.groupId) candidates.push(event.groupId, `${event.platform}:${event.groupId}`, `${event.platform}:group:${event.groupId}`);
  return candidates.some((c) => list.includes(c));
};

const MOOD_OPENERS = {
  happy: (call, me) => `${call}～${me}在呢！`,
  focused: (call, me) => `${call}，${me}在认真听。`,
  sleepy: (call, me) => `${call}……${me}有点困，但还是想回你～`,
  sulking: (call, me) => `哼，${call}终于想起${me}了。`,
};

/** Default in-character reply (persona + mood + recalled memory). */
export function buildTemplateReply({ persona = {}, state = {}, text = '', memories = {}, trusted = true } = {}) {
  const me = str(persona.selfRef) || '我';
  const call = str(persona.callUser) || '你';
  const opener = (MOOD_OPENERS[state.mood] ?? MOOD_OPENERS.happy)(call, me);
  const lines = [opener];
  const fact = (memories.facts ?? []).find((f) => !str(f.topic).startsWith('[im:'));
  const wiki = (memories.wiki ?? [])[0];
  if (trusted && fact) lines.push(`${me}记得「${clip(fact.topic, 20)}」：${clip(fact.content, 60)}`);
  else if (trusted && wiki) lines.push(`${me}翻了翻小本本，《${clip(wiki.title, 20)}》里有相关的记录。`);
  lines.push(`你说的「${clip(text.replace(/\s+/g, ' '), 30)}」${me}收到了。`);
  return lines.join('\n');
}

async function generateReply(ctx, options) {
  const generator =
    typeof options.replyGenerator === 'function'
      ? options.replyGenerator
      : typeof options.sessionController?.generateReply === 'function'
        ? (c) => options.sessionController.generateReply(c)
        : null;
  if (generator) {
    try {
      const out = await generator(ctx);
      const text = typeof out === 'string'
        ? out
        : str(out?.text || out?.reply || out?.content);
      if (text.trim()) return text.trim();
    } catch {
      // fall back to the template: a broken generator must never silence the companion
    }
  }
  return buildTemplateReply(ctx);
}

/**
 * Feed one inbound IM message into Soulmate.
 * event: { platform, senderId, senderName, text, groupId, contextToken, messageId, sessionWebhook }
 * options: { dispatchReply = true, replyGenerator, sessionController, memoryVisibility, fetchImpl, ... }
 */
export async function handleInboundImMessage(soulmateService, event = {}, options = {}) {
  const platform = normalizePlatform(event.platform);
  if (!platform) return { ok: false, error: `unknown platform "${event.platform}"` };
  const home = soulmateService.home;
  const senderId = str(event.senderId).trim();
  const text = clip(str(event.text).trim(), MAX_INBOUND_CHARS);
  if (!senderId) return { ok: false, error: 'senderId is required' };
  if (!text) return { ok: true, ignored: true, reason: 'empty' };
  const ev = { ...event, platform, senderId, text, groupId: str(event.groupId) };
  const dispatchEnabled = options.dispatchReply !== false;

  const [conf, creds] = await Promise.all([loadConfig(home), loadPlatformCreds(home, platform)]);

  // 1. whitelist
  const whitelist = (Array.isArray(conf.extensions?.imWhitelist) ? conf.extensions.imWhitelist : []).map((x) => str(x).trim()).filter(Boolean);
  if (whitelist.length > 0 && !whitelistHit(whitelist, ev)) {
    return { ok: true, ignored: true, reason: 'not_whitelisted', platform, senderId };
  }
  const OWNER_KEYS = { weixin: 'imOwnerWeixin', qq: 'imOwnerQq', feishu: 'imOwnerFeishu', dingtalk: 'imOwnerDingtalk' };
  const ownerOverride = str(conf.extensions?.[OWNER_KEYS[platform]]).trim();
  const ownerId = ownerOverride || (platform === 'weixin' ? creds.userId : creds.ownerId);
  const isGroup = Boolean(str(ev.groupId).trim());
  const isOwner = Boolean(ownerId) && str(ownerId) === senderId;
  // memories are only quoted back to the owner or a whitelisted sender in a DM — and
  // never inside a group: other members would read them too.
  const trusted = !isGroup && (whitelist.length > 0 || isOwner);

  // privacy firewall (inbound): a high-risk secret never enters memory and is never recalled/echoed
  const checked = inspectAndScrub(text);
  if (!checked.allowed) {
    await appendPrivacyAudit(home, { action: 'im_inbound_blocked', platform, reason: checked.blockedReason });
    const persona = conf.persona ?? {};
    const reply = `${str(persona.callUser) || '你'}，刚才那条看起来包含密钥/密码类敏感信息（${checked.blockedReason}），${str(persona.selfRef) || '我'}没有记下来。建议撤回并尽快更换。`;
    const dispatched = dispatchEnabled ? await dispatchReply(home, ev, reply, options) : null;
    const labelBlocked = clip(str(ev.senderName).trim() || senderId, 24);
    await appendImChat(home, { platform, peerId: senderId, peerLabel: labelBlocked, groupId: str(ev.groupId), role: 'user', text: '[已拦截敏感内容]', messageId: str(ev.messageId) }).catch(() => {});
    if (reply) await appendImChat(home, { platform, peerId: senderId, peerLabel: labelBlocked, groupId: str(ev.groupId), role: 'bot', text: reply }).catch(() => {});
    return { ok: true, blocked: true, blockedReason: checked.blockedReason, recorded: false, platform, senderId, reply, dispatched };
  }

  // 2. recall (never includes local-only private memories: this text goes to third-party servers)
  const recalled = await soulmateService.recall(text, { limit: 3, channel: 'im' });
  const memories = recalled?.ok ? recalled : { facts: [], wiki: [], episodes: [] };

  // 3. mood / affinity
  const state = await soulmateService.interact('chat');

  // 4. memory: one rolling "[im:<platform>]" fact neuron per contact
  const label = clip(str(ev.senderName).trim() || senderId, 24);
  const factId = `f_im_${platform}_${createHash('sha1').update(`${senderId}|${ev.groupId}`).digest('hex').slice(0, 12)}`;
  const lines = digests.get(factId) ?? [];
  lines.push(`${label}${ev.groupId ? '（群）' : ''}：${clip(checked.scrubbedText.replace(/\s+/g, ' '), 200)}`);
  while (lines.length > DIGEST_LINES) lines.shift();
  digests.set(factId, lines);
  if (digests.size > 200) digests.delete(digests.keys().next().value);
  const retained = await soulmateService.retainFact({
    id: factId,
    topic: `[im:${platform}] ${label}`,
    content: `最近在${IM_PLATFORM_LABELS[platform]}上的对话：\n${lines.map((l) => `- ${l}`).join('\n')}`,
    category: 'im',
    importance: 2,
    decayClass: 'emotion', // v3 §1: rolling conversation digest = short-lived conversational mood
    halfLifeDays: 14,
    visibility: options.memoryVisibility === 'private' ? 'private' : 'syncable',
  });

  // 5. timeline: log the user line FIRST so the bubble order stays 你→我
  //    even if generateReply takes seconds or a tool side-sends early.
  const userLogged = await appendImChat(home, {
    platform,
    peerId: senderId,
    peerLabel: label,
    groupId: str(ev.groupId),
    role: 'user',
    text: checked.scrubbedText,
    messageId: str(ev.messageId),
  }).catch(() => null);
  const userAtMs = Date.parse(userLogged?.entry?.at || '') || Date.now();

  // 6. in-character reply
  const persona = { ...(conf.persona ?? {}), name: getDisplayName(conf.persona) };
  const reply = clip(
    await generateReply({
      event: ev,
      text,
      persona,
      state,
      mood: state.mood,
      memories,
      trusted,
      platform,
      // Speaker identity: in a group she must know whether 主人 or a 群友 is talking.
      speaker: {
        isGroup,
        isOwner,
        name: str(ev.senderName).trim(),
        label: isOwner ? '主人' : isGroup ? '群友' : '对方',
        groupId: str(ev.groupId),
      },
    }, options),
    1800
  );

  // If the home-session model already called soulmate_im_send during generateReply,
  // a bot line appears AFTER our user line — skip second dispatch/log (avoids 你夹在两段回复中间).
  const alreadySent = await recentImBotSend(home, { platform, peerId: senderId, withinMs: 20_000 }).catch(() => null);
  const sentDuringThisTurn = alreadySent && Date.parse(alreadySent.at) >= userAtMs;
  let dispatched = null;
  if (sentDuringThisTurn) {
    dispatched = { ok: true, skipped: 'already_sent_via_tool', messageId: alreadySent.id };
  } else {
    dispatched = dispatchEnabled ? await dispatchReply(home, ev, reply, options) : null;
    if (reply) {
      await appendImChat(home, {
        platform,
        peerId: senderId,
        peerLabel: label,
        groupId: str(ev.groupId),
        role: 'bot',
        text: reply,
      }).catch(() => {});
    }
  }

  // 7. star map: each IM thread becomes a session star (kind 'im'), content = recent
  //    exchange from the local timeline.
  if (conf.extensions?.imMemoryStars !== false && typeof soulmateService.upsertSessionEpisode === 'function') {
    try {
      const group = str(ev.groupId).trim();
      const thread = await listImChat(home, group
        ? { platform, groupId: group, limit: 40 }
        : { platform, peerId: senderId, limit: 40 });
      const rows = Array.isArray(thread?.entries) ? thread.entries : (Array.isArray(thread) ? thread : []);
      if (rows.length) {
        const content = rows
          .map((r) => {
            if (r.role === 'bot') return `我：${str(r.text)}`;
            const who = group ? (str(r.peerLabel) || '群友') : '对方';
            return `${who}：${str(r.text)}`;
          })
          .join('\n');
        await soulmateService.upsertSessionEpisode({
          sessionId: group ? `im:group:${platform}:${group}` : `im:${platform}:${senderId}`,
          title: group
            ? `${IM_PLATFORM_LABELS[platform] || platform}群 · ${clip(str(ev.groupName).trim() || group, 24)}`
            : `${IM_PLATFORM_LABELS[platform] || platform} · ${label}`,
          content,
          kind: 'im',
        });
      }
    } catch (err) {
      console.warn('[soulmate-im] im memory star failed', err?.message || err);
    }
  }

  return {
    ok: true,
    platform,
    senderId,
    reply,
    recalled: { facts: memories.facts?.length ?? 0, wiki: memories.wiki?.length ?? 0, episodes: memories.episodes?.length ?? 0 },
    memory: retained?.ok ? { factId: retained.fact.id } : null,
    recorded: Boolean(retained?.ok),
    state: { mood: state.mood, affinity: state.affinity },
    dispatched,
  };
}

// ---------------------------------------------------------------------------
// Management actions shared by the model tool and the HTTP route
// ---------------------------------------------------------------------------

export const IM_MANAGE_ACTIONS = Object.freeze([
  'status',
  'configure',
  'weixin_qr_start',
  'weixin_qr_poll',
  'weixin_logout',
  'weixin_poll',
  'stream_ticket',
]);

/** args: { action, platform, credentials, enabled, mode, whitelist, qrcode, timeoutMs } */
export async function manageIm(soulmateService, args = {}, options = {}) {
  const home = soulmateService.home;
  const action = str(args.action) || 'status';
  switch (action) {
    case 'status':
      return getImStatus(home);
    case 'configure': {
      const p = normalizePlatform(args.platform);
      if (Array.isArray(args.whitelist)) {
        await saveConfigAuto(home, { extensions: { imWhitelist: args.whitelist.map((x) => str(x).trim()).filter(Boolean) } });
      }
      if (typeof args.imEnabled === 'boolean') await saveConfigAuto(home, { extensions: { imEnabled: args.imEnabled } });
      if (p) {
        const credentials = isObject(args.credentials) ? { ...args.credentials } : {};
        if (p === 'qq' && (args.mode === 'official' || args.mode === 'onebot')) credentials.mode = args.mode;
        if (Object.keys(credentials).length) await saveImCredentials(home, p, credentials);
        await setPlatformEnabled(home, p, args.enabled !== false, p === 'qq' && credentials.mode ? { mode: credentials.mode } : {});
        await appendPrivacyAudit(home, { action: 'im_configured', platform: p });
      } else if (args.platform) {
        return { ok: false, error: `unknown platform "${args.platform}" (expected ${IM_PLATFORMS.join(' | ')})` };
      }
      return getImStatus(home);
    }
    case 'weixin_qr_start':
      return startWeixinQrLogin(home, options);
    case 'weixin_qr_poll':
      return pollWeixinQrStatus(home, str(args.qrcode), options);
    case 'weixin_logout':
      return logoutWeixin(home);
    case 'weixin_poll': {
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.min(45_000, Math.max(1000, args.timeoutMs)) : options.timeoutMs;
      return pollWeixinUpdatesOnce(soulmateService, { ...options, ...(timeoutMs ? { timeoutMs } : {}) });
    }
    case 'stream_ticket':
      return openDingtalkStreamTicket(home, options);
    default:
      return { ok: false, error: `unknown action "${action}" (expected ${IM_MANAGE_ACTIONS.join(' | ')})` };
  }
}

/** Dispatch a webhook payload to the right platform handler. */
export async function handleImWebhook(soulmateService, platform, body, options = {}) {
  const p = normalizePlatform(platform);
  switch (p) {
    case 'qq':
      return handleQqWebhook(soulmateService, body, options);
    case 'feishu':
      return handleFeishuWebhook(soulmateService, body, options);
    case 'dingtalk':
      return handleDingtalkWebhook(soulmateService, body, options);
    default:
      return { ok: false, status: 400, error: `webhook is not supported for "${platform}" (qq | feishu | dingtalk)` };
  }
}
