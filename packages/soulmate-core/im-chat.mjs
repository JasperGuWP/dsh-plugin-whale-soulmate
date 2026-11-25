// IM conversation timeline (WeChat-style threads) — jsonl under soulmate logs.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendJsonl, readJsonlTail } from './state.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function imChatPath(home) {
  return join(home.logsDir || home.rootDir, 'im-chat.jsonl');
}

export function normalizeImChatEntry(raw = {}) {
  const platform = str(raw.platform || 'weixin').trim() || 'weixin';
  const peerId = str(raw.peerId).trim();
  const role = raw.role === 'bot' ? 'bot' : 'user';
  const at = str(raw.at) || new Date().toISOString();
  const text = str(raw.text);
  const id =
    str(raw.id)
    || createHash('sha1').update(`${platform}|${peerId}|${role}|${at}|${text}`).digest('hex').slice(0, 16);
  return {
    id,
    at,
    platform,
    peerId,
    peerLabel: str(raw.peerLabel) || peerId,
    // Group threads keep their group id so one group reads as one conversation.
    groupId: str(raw.groupId),
    role,
    text,
    messageId: str(raw.messageId),
    // Rich media (QQ official attachments / outbound media sends). Each item:
    // { contentType, url, filename?, voiceWavUrl?, asrText? }. Text stays the caption.
    media: Array.isArray(raw.media)
      ? raw.media
        .filter((m) => m && typeof m === 'object' && (str(m.contentType) || str(m.url)))
        .map((m) => ({
          contentType: str(m.contentType),
          url: str(m.url),
          ...(str(m.filename) ? { filename: str(m.filename) } : {}),
          ...(str(m.voiceWavUrl) ? { voiceWavUrl: str(m.voiceWavUrl) } : {}),
          ...(str(m.asrText) ? { asrText: str(m.asrText) } : {}),
        }))
        .slice(0, 9)
      : [],
    senderId: str(raw.senderId),
    senderName: str(raw.senderName),
  };
}

export async function appendImChat(home, entry) {
  const row = normalizeImChatEntry(entry);
  const hasMedia = row.media.length > 0;
  if (!row.peerId || (!row.text.trim() && !hasMedia)) return { ok: false, error: 'peerId and text required' };
  // Platform-messageId dedupe: the same send can arrive from two mirrors (proactive
  // append + outbound journal import). One platform message = one timeline row.
  if (row.messageId) {
    const tail = await readJsonlTail(imChatPath(home), 60).catch(() => []);
    if (tail.some((r) => r?.messageId === row.messageId && r?.platform === row.platform)) {
      return { ok: true, entry: row, duplicate: true };
    }
  }
  await appendJsonl(imChatPath(home), row);
  return { ok: true, entry: row };
}

/** Newest bot line for a peer within `withinMs` (used to skip duplicate outbound logs). */
export async function recentImBotSend(home, { platform = 'weixin', peerId = '', withinMs = 12_000 } = {}) {
  const peer = str(peerId).trim();
  if (!peer) return null;
  const rows = await listImChat(home, { platform, peerId: peer, limit: 8 });
  const latestBot = rows.find((r) => r.role === 'bot');
  if (!latestBot) return null;
  const t = Date.parse(latestBot.at);
  if (!Number.isFinite(t) || Date.now() - t > withinMs) return null;
  return latestBot;
}

/**
 * Newest-first messages for one peer (or all if peer empty).
 * `before` = ISO timestamp — return messages strictly older than it.
 */
export async function listImChat(home, { platform = 'weixin', peerId = '', groupId = '', limit = 50, before = '' } = {}) {
  const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
  const rows = await readJsonlTail(imChatPath(home), Math.max(cap * 8, 400));
  // Empty platform → all IM channels (weixin/qq/feishu/dingtalk).
  const plat = str(platform).trim();
  const peer = str(peerId).trim();
  const group = str(groupId).trim();
  const beforeMs = before ? Date.parse(before) : NaN;
  let list = rows
    .map((r) => normalizeImChatEntry(r))
    .filter((r) => (!plat || r.platform === plat))
    .filter((r) => (group ? r.groupId === group : (!peer || (r.peerId === peer && !r.groupId))));
  if (Number.isFinite(beforeMs)) {
    list = list.filter((r) => {
      const t = Date.parse(r.at);
      return Number.isFinite(t) && t < beforeMs;
    });
  }
  // rows from readJsonlTail are oldest→newest within the tail; we want newest first for paging
  list = list.slice().reverse();
  return list.slice(0, cap);
}

/** Aggregate contacts for a platform: last message + count. Newest activity first. */
export async function listImContacts(home, { platform = 'weixin', limit = 80 } = {}) {
  const plat = str(platform).trim() || 'weixin';
  const rows = await readJsonlTail(imChatPath(home), 2000);
  const map = new Map();
  for (const raw of rows) {
    const r = normalizeImChatEntry(raw);
    if (r.platform !== plat || !r.peerId) continue;
    // Group conversations aggregate by group, not by each member's peerId.
    const key = r.groupId ? `g:${r.groupId}` : r.peerId;
    const prev = map.get(key);
    if (!prev || String(r.at) >= String(prev.lastAt)) {
      map.set(key, {
        peerId: r.groupId || r.peerId,
        groupId: r.groupId || '',
        peerLabel: r.groupId ? (prev?.peerLabel || `群 ${r.groupId.slice(0, 8)}…`) : (r.peerLabel || r.peerId),
        lastAt: r.at,
        lastText: r.text,
        lastRole: r.role,
        count: (prev?.count || 0) + 1,
      });
    } else {
      prev.count += 1;
    }
  }
  return [...map.values()]
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, Math.min(200, Math.max(1, Math.floor(Number(limit) || 80))));
}
