// Official-QQ proactive send: reuse the official bot's appId/appSecret (from the
// profile patch) and a fresh msg_id (from the bridge's transcript scan) to push inside
// QQ's passive-reply window. Split out of im-proactive-runtime to keep it under the
// assembly size ceiling.

import { QQ_OFFICIAL_API_BASE, QQ_OFFICIAL_TOKEN_URL } from '../../soulmate-im/index.mjs';
import { readQqReplyIds } from '../qqbot-msgid-mirror.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

async function httpJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetchImpl(url, init);
  const text = typeof res.text === 'function' ? await res.text() : '';
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep {} */ }
  const status = Number(res.status) || 0;
  return { status, ok: status >= 200 && status < 300, data: data && typeof data === 'object' ? data : {}, text };
}

export function createOfficialQqSender({ bridge, cfg, warn }) {
  let tokenCache = { key: '', token: '', until: 0 };

  async function token(creds, fetchImpl) {
    const key = creds.appId;
    if (tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.until) return tokenCache.token;
    const res = await httpJson(fetchImpl, QQ_OFFICIAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { appId: creds.appId, clientSecret: creds.appSecret },
    });
    if (!res.ok || !res.data.access_token) throw new Error(`qq token exchange failed (HTTP ${res.status})`);
    tokenCache = {
      key,
      token: str(res.data.access_token),
      until: Date.now() + Math.max(60, Number(res.data.expires_in) || 7200) * 1000 - 60_000,
    };
    return tokenCache.token;
  }

  /**
   * @returns {ok, error?, trySoulmateIm?} — trySoulmateIm=true only when the official
   * channel is absent entirely (no creds), so a configured-but-closed window is a
   * honest failure, not a silent reroute to an unconfigured channel.
   */
  return async function officialSend({ target, text, at = Date.now() }) {
    try {
      const info = await bridge.officialSendTargets({ nowMs: at });
      if (!info.ok) {
        return info.reason === 'no-official-creds'
          ? { ok: false, trySoulmateIm: true, error: 'official qq not configured' }
          : { ok: false, error: `official qq: ${info.reason}` };
      }
      // The SDK mirror IS the authoritative passive-window record (real msg_ids with
      // timestamps). The transcript-based info.targets lagged behind (zstd frame reads),
      // reporting "window closed" while fresh ids sat in the mirror. Trust the mirror.
      const scope = target.groupId ? 'group' : 'c2c';
      const targetId = target.groupId || target.to;
      const realIds = await readQqReplyIds(scope, targetId, at);
      if (!realIds.length) {
        return { ok: false, error: '被动窗口已关（群5分钟/私聊30分钟内对方没说话），官方通道此刻发不出主动消息' };
      }
      const fetchImpl = cfg?.fetch || globalThis.fetch;
      const accessToken = await token(info.creds, fetchImpl);
      const url = target.groupId
        ? `${QQ_OFFICIAL_API_BASE}/v2/groups/${encodeURIComponent(target.groupId)}/messages`
        : `${QQ_OFFICIAL_API_BASE}/v2/users/${encodeURIComponent(target.to)}/messages`;
      let lastErr = '';
      for (const cand of realIds) {
        const res = await httpJson(fetchImpl, url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${accessToken}`,
            'X-Union-Appid': info.creds.appId,
          },
          body: { content: clip(str(text), 2000), msg_type: 0, msg_id: cand.msgId },
        });
        if (res.ok && !(res.data.code && !res.data.id)) {
          return { ok: true, platform: 'qq', mode: 'official-bridge', messageId: str(res.data.id) };
        }
        lastErr = `qq official send failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 120)}` : ''}`;
        // Only try the next cached id when this one was rejected as invalid/exhausted.
        if (!/msg_id|越权|无效|频|limit/i.test(String(res.data.message || ''))) break;
      }
      return { ok: false, error: lastErr || 'qq official send failed' };
    } catch (err) {
      warn?.('official qq send failed', err);
      return { ok: false, error: errMsg(err) };
    }
  };
}