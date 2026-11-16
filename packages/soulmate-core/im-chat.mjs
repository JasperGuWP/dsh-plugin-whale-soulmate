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
    role,
    text,
    messageId: str(raw.messageId),
  };
}

export async function appendImChat(home, entry) {
  const row = normalizeImChatEntry(entry);
  if (!row.peerId || !row.text.trim()) return { ok: false, error: 'peerId and text required' };
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
export async function listImChat(home, { platform = 'weixin', peerId = '', limit = 50, before = '' } = {}) {
  const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
  const rows = await readJsonlTail(imChatPath(home), Math.max(cap * 8, 400));
  const plat = str(platform).trim() || 'weixin';
  const peer = str(peerId).trim();
  const beforeMs = before ? Date.parse(before) : NaN;
  let list = rows
    .map((r) => normalizeImChatEntry(r))
    .filter((r) => r.platform === plat && (!peer || r.peerId === peer));
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
    const prev = map.get(r.peerId);
    if (!prev || String(r.at) >= String(prev.lastAt)) {
      map.set(r.peerId, {
        peerId: r.peerId,
        peerLabel: r.peerLabel || r.peerId,
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
