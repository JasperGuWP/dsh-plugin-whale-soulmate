// QQ C2C stream messages: incremental "typing out" output in a private chat, via the
// official /v2/users/{openid}/stream_messages protocol (replace semantics — every frame
// carries the FULL text so far; index advances, msg_seq stays constant per stream).
// Requires an open passive window (real msg_id from the SDK mirror). Markdown content.

import { QQ_OFFICIAL_API_BASE, QQ_OFFICIAL_TOKEN_URL } from '../../soulmate-im/index.mjs';
import { readQqReplyIds } from '../qqbot-msgid-mirror.mjs';
import { recordQqOutbound } from '../qqbot-inbound-mirror.mjs';
import { inspectAndScrub, appendPrivacyAudit } from '../privacy-firewall.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';

const MIN_GAP_MS = 400;

async function httpJson(fetchImpl, url, { method = 'POST', headers = {}, body, timeoutMs = 20_000 } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchImpl(url, init);
  const text = typeof res.text === 'function' ? await res.text() : '';
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep {} */ }
  const status = Number(res.status) || 0;
  return { status, ok: status >= 200 && status < 300, data: data && typeof data === 'object' ? data : {} };
}

export function createOfficialQqStream({ bridge, cfg, warn, home, outboundRecord = recordQqOutbound }) {
  let tokenCache = { key: '', token: '', until: 0 };
  const fetchImpl = () => cfg?.fetch || globalThis.fetch;

  async function token(creds) {
    if (tokenCache.key === creds.appId && tokenCache.token && Date.now() < tokenCache.until) return tokenCache.token;
    const res = await httpJson(fetchImpl(), QQ_OFFICIAL_TOKEN_URL, {
      headers: { 'Content-Type': 'application/json' },
      body: { appId: creds.appId, clientSecret: creds.appSecret },
    });
    if (!res.ok || !res.data.access_token) throw new Error(`qq token exchange failed (HTTP ${res.status})`);
    tokenCache = {
      key: creds.appId,
      token: str(res.data.access_token),
      until: Date.now() + Math.max(60, Number(res.data.expires_in) || 7200) * 1000 - 60_000,
    };
    return tokenCache.token;
  }

  /**
   * Open one stream. Returns { ok, update(fullText), complete(finalText?) } or an honest
   * failure (window closed / no creds). update() is throttled; complete() sends the DONE
   * frame and mirrors the final line into the outbound journal.
   */
  async function openStream({ to, at = Date.now() }) {
    try {
      const info = await bridge.officialSendTargets({ nowMs: at });
      if (!info.ok || !info.creds) return { ok: false, error: 'official qq not configured' };
      const targetId = str(to);
      if (!targetId) return { ok: false, error: 'to is required' };
      const ids = await readQqReplyIds('c2c', targetId, at);
      if (!ids.length) return { ok: false, error: '被动窗口已关，流式消息需要窗口内 msg_id' };
      const creds = info.creds;
      const accessToken = await token(creds);
      const url = `${QQ_OFFICIAL_API_BASE}/v2/users/${encodeURIComponent(targetId)}/stream_messages`;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${accessToken}`,
        'X-Union-Appid': creds.appId,
      };
      const anchorId = ids[0].msgId;
      const seq = ((Date.now() % 100_000_000) ^ Math.floor(Math.random() * 65536)) % 65536;
      let index = 0;
      let streamMsgId = '';
      let lastFlush = 0;
      let lastText = '';
      let done = false;

      async function flush(text, state) {
        const checked = inspectAndScrub(str(text));
        if (!checked.allowed) {
          if (home) await appendPrivacyAudit(home, { action: 'im_send_blocked', platform: 'qq', reason: checked.blockedReason }).catch(() => {});
          throw new Error(`消息被隐私防火墙拦截：${checked.blockedReason}`);
        }
        const body = {
          input_mode: 'replace',
          input_state: state,
          content_type: 'markdown',
          content_raw: clip(checked.scrubbedText, 4000),
          event_id: anchorId,
          msg_id: anchorId,
          msg_seq: seq,
          index: index++,
          ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
        };
        const res = await httpJson(fetchImpl(), url, { headers, body });
        if (!res.ok || (res.data.code && !res.data.id)) {
          throw new Error(`qq stream frame failed (HTTP ${res.status})${res.data.message ? `: ${clip(res.data.message, 120)}` : ''}`);
        }
        if (res.data.id && !streamMsgId) streamMsgId = str(res.data.id);
        lastFlush = Date.now();
        lastText = checked.scrubbedText;
        return res.data;
      }

      return {
        ok: true,
        async update(fullText) {
          if (done) return { ok: false, error: 'stream already completed' };
          const wait = MIN_GAP_MS - (Date.now() - lastFlush);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          try {
            await flush(fullText, 1);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: errMsg(err) };
          }
        },
        async complete(finalText) {
          if (done) return { ok: false, error: 'stream already completed' };
          done = true;
          try {
            const data = await flush(str(finalText) || lastText, 10);
            const messageId = str(data?.id) || streamMsgId;
            await outboundRecord({ kind: 'c2c', targetId, messageId, text: lastText, via: 'stream' }).catch(() => {});
            return { ok: true, platform: 'qq', mode: 'official-stream', messageId };
          } catch (err) {
            warn?.('official qq stream complete failed', err);
            return { ok: false, error: errMsg(err) };
          }
        },
      };
    } catch (err) {
      warn?.('official qq stream open failed', err);
      return { ok: false, error: errMsg(err) };
    }
  }

  /** One-shot convenience: stream a finished text in a few frames (typing effect). */
  async function streamText({ to, text, chunkChars = 24, at = Date.now() }) {
    const s = await openStream({ to, at });
    if (!s.ok) return s;
    const full = str(text);
    for (let i = Math.max(1, Number(chunkChars) || 24); i < full.length; i += Math.max(1, Number(chunkChars) || 24)) {
      const res = await s.update(full.slice(0, i));
      if (!res.ok) return res;
    }
    return s.complete(full);
  }

  return { openStream, streamText };
}