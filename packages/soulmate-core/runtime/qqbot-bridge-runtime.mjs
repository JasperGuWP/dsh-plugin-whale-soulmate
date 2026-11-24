// Bridge the official QQ bot into soulmate's memory: the official plugin keeps one
// DSH session per QQ conversation, mapped in ~/.dsh-qqbot/model-prefs.json. This
// module tails those sessions (zstd JSONL), mirrors messages into the IM timeline and
// refreshes the conversation's memory star — so QQ groups/DMs appear next to every
// other conversation instead of living in an invisible parallel world.
//
// Read-only on the official side. Owner identity: the c2c peer openid is the owner;
// in group transcripts each line carries `[名字 (openid)]`, so 主人 vs 群友 is exact.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecodeAll } from '../zstd-frames.mjs';
import { appendImChat, listImChat } from '../im-chat.mjs';
import { upsertSessionEpisode } from '../memory-engine.mjs';
import { atomicWriteJson, appendJsonl, loadConfig } from '../state.mjs';
import { clip } from '../small-utils.mjs';

const PREF_PATH = join(homedir(), '.dsh-qqbot', 'model-prefs.json');
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** Conversation key → { kind: 'c2c'|'group', peer, groupId, appId } */
export function parseConversationKey(key) {
  const m = /^qqbot:(\d+):(c2c|group):([0-9A-Za-z]+)$/.exec(String(key || '').trim());
  if (!m) return null;
  return m[2] === 'group'
    ? { kind: 'group', appId: m[1], groupId: m[3], peer: m[3] }
    : { kind: 'c2c', appId: m[1], peer: m[3], groupId: '' };
}

/**
 * Latest inbound message id + age per conversation, from the session transcripts.
 * QQ's official API only accepts a proactive push inside the passive-reply window
 * (group 5min / c2c 30min, ≤4 replies per msg_id) — an id-less send is rejected with
 * 40034005. The official plugin keeps its msg-id cache in memory, so we re-derive the
 * ids from the transcript envelopes instead.
 */
export function latestInboundIds(lines, { kind = 'c2c', nowMs = Date.now() } = {}) {
  let best = null;
  for (const row of Array.isArray(lines) ? lines : []) {
    if (row?.type !== 'user/message') continue;
    const data = row.data || {};
    const id = String(data.id || '').trim();
    const time = Number(row.time) || 0;
    if (!id || !time) continue;
    const raw = (data.content || []).filter((c) => c?.type === 'text').map((c) => String(c.text || '')).join('\n');
    if (/^<system-reminder>/.test(raw.trim()) || /Time sampled while preparing/.test(raw)) continue;
    // Group history envelopes replay old lines; only the current message carries a fresh id.
    if (!best || time > best.time) best = { msgId: id, time };
  }
  if (!best) return null;
  const windowMs = kind === 'group' ? 5 * 60_000 : 30 * 60_000;
  return { ...best, fresh: nowMs - best.time < windowMs, ageMs: nowMs - best.time };
}

const stripMention = (t) => String(t)
  .replace(/<@!?[0-9A-Za-z]+>/g, '')
  .replace(/\(@you\)/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Turn one session's JSONL lines into conversation events newer than `sinceSeq`.
 * Understands the official envelope: history blocks, [Current message], and the
 * `[名字 (openid)] ` speaker prefix in group chats.
 */
export function parseQqSession(lines, { sinceSeq = 0, kind = 'c2c' } = {}) {
  const out = [];
  for (const row of Array.isArray(lines) ? lines : []) {
    const seq = Number(row?.seq) || 0;
    if (seq <= sinceSeq) continue;
    const type = String(row?.type || '');
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = row.data || {};
    const msg = type === 'assistant/message' ? (data.message || data) : data;
    const raw = (msg.content || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => String(c.text || ''))
      .join('\n')
      .trim();
    if (!raw) continue;
    if (/^<system-reminder>/.test(raw) || /Time sampled while preparing/.test(raw)) continue;
    const at = Number.isFinite(Number(row.time)) ? new Date(Number(row.time)).toISOString() : new Date().toISOString();

    if (type === 'assistant/message') {
      out.push({ seq, role: 'bot', text: clip(stripMention(raw), 1800), at, senderName: '', senderId: '' });
      continue;
    }
    // User turn: keep only the current message; history blocks are replay context.
    let text = raw;
    const curIdx = text.lastIndexOf('[Current message]');
    if (curIdx >= 0) text = text.slice(curIdx + '[Current message]'.length);
    text = text.split('\n').filter((l) => !/^\[Chat history (begins|ends)\]/.test(l.trim())).join('\n').trim();
    if (!text) continue;
    let senderName = '';
    let senderId = '';
    const m = /^\[([^\[\]]+?)\s*\(([0-9A-Fa-f]{32})\)\]\s*([\s\S]*)$/.exec(text);
    if (m) {
      senderName = m[1].trim();
      senderId = m[2].toUpperCase();
      text = m[3];
    }
    text = clip(stripMention(text), 1800);
    if (!text) continue;
    if (kind === 'c2c' && !senderName) senderName = '主人';
    out.push({ seq, role: 'user', text, at, senderName, senderId });
  }
  return out;
}

async function findSessionFile(sessionsRoot, sessionId) {
  try {
    for (const dir of await readdir(sessionsRoot)) {
      const p = join(sessionsRoot, dir, sessionId, SESSION_FILE);
      if (existsSync(p)) return p;
    }
  } catch { /* no sessions root */ }
  return null;
}

export function createQqbotBridgeRuntime({ home, warn, pushEvent, prefsPath = PREF_PATH, sessionsRoot = SESSIONS_ROOT }) {
  const cursorPath = join(home.rootDir, 'logs', 'qqbot-bridge-cursor.json');

  async function loadCursor() {
    try { return JSON.parse(await readFile(cursorPath, 'utf8')) || {}; } catch { return {}; }
  }
  async function saveCursor(cursor) {
    await atomicWriteJson(cursorPath, cursor).catch(() => {});
  }

  /** One pass. Returns a summary for the tick result. */
  async function runQqbotBridgeIfEnabled() {
    const conf = await loadConfig(home).catch(() => null);
    if (conf?.extensions?.qqbotBridge === false) return { ok: true, ran: false, reason: 'disabled' };
    let prefs;
    try { prefs = JSON.parse(await readFile(prefsPath, 'utf8')); } catch { return { ok: true, ran: false, reason: 'no-prefs' }; }
    const sessionIds = prefs?.sessionIds && typeof prefs.sessionIds === 'object' ? prefs.sessionIds : {};
    const entries = Object.entries(sessionIds).map(([key, sessionId]) => ({ key, conv: parseConversationKey(key), sessionId: String(sessionId || '') }))
      .filter((e) => e.conv && e.sessionId);
    if (!entries.length) return { ok: true, ran: false, reason: 'no-conversations' };

    // The owner openid is the c2c peer (the bot's human). Group senders are compared to it.
    const ownerId = String(conf?.extensions?.imOwnerQq || '').trim().toUpperCase()
      || (entries.find((e) => e.conv.kind === 'c2c')?.conv.peer || '').toUpperCase();

    const cursor = await loadCursor();
    let imported = 0;
    let conversations = 0;
    for (const { conv, sessionId } of entries) {
      const file = await findSessionFile(sessionsRoot, sessionId);
      if (!file) continue;
      let raw;
      try { raw = zstdDecodeAll(await readFile(file)); } catch { continue; }
      const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const sinceSeq = Number(cursor[sessionId]?.seq) || 0;
      const events = parseQqSession(lines, { sinceSeq, kind: conv.kind });
      if (!events.length) continue;
      conversations += 1;
      for (const ev of events) {
        const isOwner = ev.role === 'user' && ownerId && ev.senderId === ownerId;
        const label = conv.kind === 'group'
          ? (ev.role === 'bot' ? '' : (isOwner ? '主人' : (ev.senderName || '群友')))
          : (ev.role === 'bot' ? '' : (ev.senderName || '主人'));
        await appendImChat(home, {
          platform: 'qq',
          peerId: conv.kind === 'group' ? conv.groupId : conv.peer,
          peerLabel: label || (ev.role === 'bot' ? '我' : ''),
          groupId: conv.groupId,
          role: ev.role,
          text: ev.text,
          at: ev.at,
        }).catch(() => {});
        imported += 1;
        // Owner turns are interactions too — the experience layer pairs her proactive
        // attempts with these; without this row QQ answers never counted as responses.
        if (isOwner) {
          await appendJsonl(join(home.rootDir, 'logs', 'interactions.jsonl'), {
            at: ev.at, action: 'chat', via: 'qq',
          }).catch(() => {});
        }
      }
      const lastSeq = Math.max(...events.map((e) => e.seq));
      cursor[sessionId] = { seq: lastSeq, at: new Date().toISOString(), conv: conv.kind, peer: conv.peer };
    }
    await saveCursor(cursor);

    if (!imported) return { ok: true, ran: true, imported: 0, conversations: 0 };

    // Refresh one memory star per conversation that had new lines.
    for (const { conv } of entries) {
      try {
        const thread = conv.kind === 'group'
          ? await listImChat(home, { platform: 'qq', groupId: conv.groupId, limit: 40 })
          : await listImChat(home, { platform: 'qq', peerId: conv.peer, limit: 40 });
        if (!Array.isArray(thread) || !thread.length) continue;
        const content = thread
          .map((r) => (r.role === 'bot' ? `我：${r.text}` : `${r.peerLabel || (conv.kind === 'group' ? '群友' : '对方')}：${r.text}`))
          .join('\n');
        await upsertSessionEpisode(home, {
          sessionId: conv.kind === 'group' ? `im:group:qq:${conv.groupId}` : `im:qq:${conv.peer}`,
          title: conv.kind === 'group' ? `QQ群 · ${conv.groupId.slice(0, 8)}` : 'QQ · 主人',
          content,
          kind: 'im',
        });
      } catch (err) {
        warn('qqbot bridge star failed', err);
      }
    }
    try { pushEvent('qqbot-bridge', { imported, conversations }); } catch { /* optional */ }
    return { ok: true, ran: true, imported, conversations, ownerKnown: Boolean(ownerId) };
  }

  /**
   * Fresh official-API send targets for the IM proactive runtime: appId/appSecret come
   * from the profile's im-qqbot entry (same credentials the official bot uses), msg_id
   * from the transcript. Only conversations inside the passive window are returned.
   */
  async function officialSendTargets({ nowMs = Date.now() } = {}) {
    let creds = null;
    try {
      const patch = await readFile(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
      const block = patch.slice(patch.indexOf('- id: im-qqbot'));
      const appId = /appId:\s*"?(\d+)"?/.exec(block)?.[1] || '';
      const appSecret = /appSecret:\s*"?([^\s"\n]+)"?/.exec(block)?.[1] || '';
      if (appId && appSecret) creds = { appId, appSecret };
    } catch { /* no profile patch */ }
    if (!creds) return { ok: false, reason: 'no-official-creds', targets: [] };
    // The SDK msg-id mirror is the authoritative passive-window record. Reading the
    // transcript here lagged (frame decoding) and reported closed windows while fresh
    // ids existed. Prefer the mirror; fall back to transcript scan only if it's empty.
    const targets = [];
    try {
      const { readFile: rf } = await import('node:fs/promises');
      const mirror = JSON.parse(await rf(join(home.rootDir, 'logs', 'qq-msgids.json'), 'utf8'));
      for (const [key, list] of Object.entries(mirror?.targets || {})) {
        const m = /^(c2c|group):(.+)$/.exec(key);
        if (!m || !Array.isArray(list) || !list.length) continue;
        const ttl = m[1] === 'group' ? 5 * 60_000 : 30 * 60_000;
        const fresh = list.filter((e) => e && nowMs - (Number(e.at) || 0) < ttl);
        if (!fresh.length) continue;
        const newest = fresh.reduce((a, b) => ((Number(b.at) || 0) > (Number(a.at) || 0) ? b : a));
        targets.push(m[1] === 'group'
          ? { kind: 'group', groupId: m[2], peer: m[2], appId: creds.appId, msgId: newest.msgId, ageMs: nowMs - Number(newest.at) }
          : { kind: 'c2c', peer: m[2], groupId: '', appId: creds.appId, msgId: newest.msgId, ageMs: nowMs - Number(newest.at) });
      }
    } catch { /* mirror absent → transcript fallback below */ }
    if (targets.length) return { ok: true, creds, targets };
    let prefs;
    try { prefs = JSON.parse(await readFile(prefsPath, 'utf8')); } catch { return { ok: false, reason: 'no-prefs', targets: [] }; }
    for (const [key, sessionId] of Object.entries(prefs?.sessionIds || {})) {
      const conv = parseConversationKey(key);
      if (!conv || conv.appId !== creds.appId) continue;
      const file = await findSessionFile(sessionsRoot, String(sessionId));
      if (!file) continue;
      let lines;
      try {
        lines = zstdDecodeAll(await readFile(file))
          .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { continue; }
      const inbound = latestInboundIds(lines, { kind: conv.kind, nowMs });
      if (inbound?.fresh) targets.push({ ...conv, msgId: inbound.msgId, ageMs: inbound.ageMs });
    }
    return { ok: true, creds, targets };
  }

  return { runQqbotBridgeIfEnabled, officialSendTargets };
}