// Official-QQ API operations beyond plain text: media upload+send, recall, typing
// indicator, c2c wakeup (the ONLY legal out-of-window proactive push, 30-day recall
// after the user initiated contact), and button-keyboard sends. Credentials come from
// the bridge (profile patch); every send that must ride the passive window reads REAL
// msg_ids from the SDK mirror. Split from qq-official-send to stay under the ceiling.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { QQ_OFFICIAL_API_BASE, QQ_OFFICIAL_TOKEN_URL } from '../../soulmate-im/index.mjs';
import { readQqReplyIds } from '../qqbot-msgid-mirror.mjs';
import { recordQqOutbound } from '../qqbot-inbound-mirror.mjs';
import { inspectAndScrub, appendPrivacyAudit } from '../privacy-firewall.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';

export const QQ_MEDIA_TYPES = Object.freeze({ image: 1, video: 2, voice: 3, file: 4 });

async function httpJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetchImpl(url, init);
  const text = typeof res.text === 'function' ? await res.text() : '';
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep {} */ }
  const status = Number(res.status) || 0;
  return { status, ok: status >= 200 && status < 300, data: data && typeof data === 'object' ? data : {}, text };
}

const msgSeq = () => (Date.now() % 100_000_000) ^ Math.floor(Math.random() * 65536);

export function createOfficialQqOps({ bridge, cfg, warn, home, outboundRecord = recordQqOutbound }) {
  let tokenCache = { key: '', token: '', until: 0 };
  const fetchImpl = () => cfg?.fetch || globalThis.fetch;

  async function token(creds) {
    const key = creds.appId;
    if (tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.until) return tokenCache.token;
    const res = await httpJson(fetchImpl(), QQ_OFFICIAL_TOKEN_URL, {
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

  async function creds() {
    const info = await bridge.officialSendTargets({ nowMs: Date.now() });
    if (!info.ok || !info.creds) return null;
    return info.creds;
  }

  const msgUrl = (scope, targetId) => `${QQ_OFFICIAL_API_BASE}/v2/${scope === 'group' ? 'groups' : 'users'}/${encodeURIComponent(targetId)}/messages`;
  const authHeaders = (c, accessToken) => ({
    'Content-Type': 'application/json',
    Authorization: `QQBot ${accessToken}`,
    'X-Union-Appid': c.appId,
  });

  /** Fresh mirror ids for a target; [] when the passive window is closed. */
  async function windowIds(scope, targetId, at = Date.now()) {
    return readQqReplyIds(scope, targetId, at);
  }

  /**
   * Send an image/video/voice/file. Two-step official flow: upload (file_type + url or
   * base64 file_data) → message with msg_type 7 + media.file_info, inside the window.
   */
  async function sendMedia({ target, mediaType, url = '', filePath = '', caption = '', at = Date.now() }) {
    try {
      const fileType = QQ_MEDIA_TYPES[str(mediaType)];
      if (!fileType) return { ok: false, error: `unknown mediaType "${mediaType}" (image|video|voice|file)` };
      if (!url && !filePath) return { ok: false, error: 'url or filePath is required' };
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured' };
      const scope = target.groupId ? 'group' : 'c2c';
      const targetId = str(target.groupId || target.to);
      if (!targetId) return { ok: false, error: 'target is required' };
      const ids = await windowIds(scope, targetId, at);
      if (!ids.length) return { ok: false, error: '被动窗口已关（群5分钟/私聊30分钟），媒体消息也需要窗口内 msg_id' };

      let checkedCaption = '';
      if (str(caption).trim()) {
        const checked = inspectAndScrub(str(caption));
        if (!checked.allowed) {
          if (home) await appendPrivacyAudit(home, { action: 'im_send_blocked', platform: 'qq', reason: checked.blockedReason }).catch(() => {});
          return { ok: false, blockedReason: checked.blockedReason, error: `消息被隐私防火墙拦截：${checked.blockedReason}` };
        }
        checkedCaption = checked.scrubbedText;
      }

      const accessToken = await token(c);
      const headers = authHeaders(c, accessToken);
      const base = `${QQ_OFFICIAL_API_BASE}/v2/${scope === 'group' ? 'groups' : 'users'}/${encodeURIComponent(targetId)}`;
      const uploadBody = { file_type: fileType, srv_send_msg: false };
      if (url) uploadBody.url = str(url);
      else {
        const buf = await readFile(filePath);
        uploadBody.file_data = buf.toString('base64');
        if (fileType === QQ_MEDIA_TYPES.file) uploadBody.file_name = basename(filePath);
      }
      const up = await httpJson(fetchImpl(), `${base}/files`, { method: 'POST', headers, body: uploadBody, timeoutMs: 60_000 });
      if (!up.ok || !up.data.file_info) {
        return { ok: false, error: `qq media upload failed (HTTP ${up.status})${up.data.message ? `: ${clip(up.data.message, 120)}` : ''}` };
      }
      let lastErr = '';
      for (const cand of ids) {
        const res = await httpJson(fetchImpl(), msgUrl(scope, targetId), {
          method: 'POST',
          headers,
          body: {
            msg_type: 7,
            media: { file_info: up.data.file_info },
            msg_seq: msgSeq(),
            msg_id: cand.msgId,
            ...(checkedCaption ? { content: clip(checkedCaption, 2000) } : {}),
          },
        });
        if (res.ok && !(res.data.code && !res.data.id)) {
          const messageId = str(res.data.id);
          await outboundRecord({ kind: scope, targetId, messageId, text: checkedCaption, mediaType: str(mediaType), via: 'media' }).catch(() => {});
          return { ok: true, platform: 'qq', mode: 'official-media', mediaType: str(mediaType), messageId };
        }
        lastErr = `qq media send failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 120)}` : ''}`;
        if (!/msg_id|越权|无效|频|limit/i.test(String(res.data.message || ''))) break;
      }
      return { ok: false, error: lastErr || 'qq media send failed' };
    } catch (err) {
      warn?.('official qq media failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /** Recall one of the bot's own messages (official DELETE on the message path). */
  async function recall({ target, messageId }) {
    try {
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured' };
      const scope = target.groupId ? 'group' : 'c2c';
      const targetId = str(target.groupId || target.to);
      const id = str(messageId);
      if (!targetId || !id) return { ok: false, error: 'target and messageId are required' };
      const accessToken = await token(c);
      const res = await httpJson(fetchImpl(), `${msgUrl(scope, targetId)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(c, accessToken),
      });
      if (!res.ok && res.status !== 204) {
        return { ok: false, error: `qq recall failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 120)}` : ''}` };
      }
      return { ok: true, platform: 'qq', mode: 'official-recall', messageId: id };
    } catch (err) {
      warn?.('official qq recall failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /** 「对方正在输入…」 indicator — c2c only, rides a fresh window id. */
  async function typing({ to, seconds = 30, at = Date.now() }) {
    try {
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured' };
      const targetId = str(to);
      if (!targetId) return { ok: false, error: 'to is required' };
      const ids = await windowIds('c2c', targetId, at);
      if (!ids.length) return { ok: false, error: '被动窗口已关，typing 需要窗口内 msg_id' };
      const accessToken = await token(c);
      const res = await httpJson(fetchImpl(), msgUrl('c2c', targetId), {
        method: 'POST',
        headers: authHeaders(c, accessToken),
        body: {
          msg_type: 6,
          input_notify: { input_type: 1, input_second: Math.min(60, Math.max(1, Number(seconds) || 30)) },
          msg_seq: msgSeq(),
          msg_id: ids[0].msgId,
        },
      });
      if (!res.ok) return { ok: false, error: `qq typing failed (HTTP ${res.status})` };
      return { ok: true, platform: 'qq', mode: 'official-typing' };
    } catch (err) {
      warn?.('official qq typing failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /**
   * c2c wakeup: the platform's legal out-of-window push (is_wakeup, 30 days after the
   * user initiated contact, frequency-capped by QQ). No msg_id needed.
   */
  async function wakeup({ to, text, at = Date.now() }) {
    try {
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured', trySoulmateIm: true };
      const targetId = str(to);
      if (!targetId) return { ok: false, error: 'to is required' };
      const checked = inspectAndScrub(str(text));
      if (!checked.allowed) {
        if (home) await appendPrivacyAudit(home, { action: 'im_send_blocked', platform: 'qq', reason: checked.blockedReason }).catch(() => {});
        return { ok: false, blockedReason: checked.blockedReason, error: `消息被隐私防火墙拦截：${checked.blockedReason}` };
      }
      const accessToken = await token(c);
      const res = await httpJson(fetchImpl(), msgUrl('c2c', targetId), {
        method: 'POST',
        headers: authHeaders(c, accessToken),
        body: { content: clip(checked.scrubbedText, 2000), msg_type: 0, msg_seq: msgSeq(), is_wakeup: true },
      });
      if (res.ok && !(res.data.code && !res.data.id)) {
        const messageId = str(res.data.id);
        await outboundRecord({ kind: 'c2c', targetId, messageId, text: checked.scrubbedText, via: 'wakeup' }).catch(() => {});
        return { ok: true, platform: 'qq', mode: 'official-wakeup', messageId };
      }
      return { ok: false, error: `qq wakeup failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 160)}` : ''}` };
    } catch (err) {
      warn?.('official qq wakeup failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /**
   * Text + inline keyboard (buttons). Window-bound. Button clicks come back as
   * INTERACTION_CREATE → qq-interactions mirror → bridge journal.
   * `buttons`: [{ label, data }] — max 5, one row.
   */
  async function sendButtons({ target, text, buttons = [], at = Date.now() }) {
    try {
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured' };
      const scope = target.groupId ? 'group' : 'c2c';
      const targetId = str(target.groupId || target.to);
      const list = (Array.isArray(buttons) ? buttons : []).filter((b) => str(b?.label) && str(b?.data)).slice(0, 5);
      if (!targetId || !list.length) return { ok: false, error: 'target and buttons[{label,data}] are required' };
      const ids = await windowIds(scope, targetId, at);
      if (!ids.length) return { ok: false, error: '被动窗口已关，按钮消息需要窗口内 msg_id' };
      const checked = inspectAndScrub(str(text));
      if (!checked.allowed) {
        if (home) await appendPrivacyAudit(home, { action: 'im_send_blocked', platform: 'qq', reason: checked.blockedReason }).catch(() => {});
        return { ok: false, blockedReason: checked.blockedReason, error: `消息被隐私防火墙拦截：${checked.blockedReason}` };
      }
      const keyboard = {
        content: {
          rows: [{
            buttons: list.map((b, i) => ({
              id: `sm-btn-${i}`,
              render_data: { label: clip(str(b.label), 20), visited_label: clip(str(b.label), 20), style: 1 },
              action: { type: 2, permission: { type: 2 }, data: clip(str(b.data), 200), click_limit: 10 },
            })),
          }],
        },
      };
      const accessToken = await token(c);
      const res = await httpJson(fetchImpl(), msgUrl(scope, targetId), {
        method: 'POST',
        headers: authHeaders(c, accessToken),
        body: { content: clip(checked.scrubbedText, 2000), msg_type: 0, msg_seq: msgSeq(), msg_id: ids[0].msgId, keyboard },
      });
      if (res.ok && !(res.data.code && !res.data.id)) {
        const messageId = str(res.data.id);
        await outboundRecord({ kind: scope, targetId, messageId, text: checked.scrubbedText, via: 'buttons' }).catch(() => {});
        return { ok: true, platform: 'qq', mode: 'official-buttons', messageId };
      }
      return { ok: false, error: `qq buttons send failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 160)}` : ''}` };
    } catch (err) {
      warn?.('official qq buttons failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /** ACK a button interaction (PUT /interactions/{id}, code 0 = success). */
  async function ackInteraction({ interactionId }) {
    try {
      const c = await creds();
      if (!c) return { ok: false, error: 'official qq not configured' };
      const id = str(interactionId);
      if (!id) return { ok: false, error: 'interactionId is required' };
      const accessToken = await token(c);
      const res = await httpJson(fetchImpl(), `${QQ_OFFICIAL_API_BASE}/interactions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: authHeaders(c, accessToken),
        body: { code: 0 },
      });
      if (!res.ok && res.status !== 204) return { ok: false, error: `qq interaction ack failed (HTTP ${res.status})` };
      return { ok: true };
    } catch (err) {
      warn?.('official qq ack failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  return { sendMedia, recall, typing, wakeup, sendButtons, ackInteraction };
}