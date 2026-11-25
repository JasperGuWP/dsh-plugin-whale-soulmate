// Live-source ingestion for the QQ bridge: consumes the mirror files written by the
// qqbot-server wrapper (same process as the official SDK) — inbound messages with real
// ids/attachments, outbound proactive sends, lifecycle events and button interactions.
// The zstd transcript scan stays as the fallback for bot replies and pre-mirror history.

import { join } from 'node:path';
import { appendImChat } from '../im-chat.mjs';
import { appendJsonl } from '../state.mjs';
import { readQqInboundSince, qqOutboundPath, qqLifecyclePath, qqInteractionsPath } from '../qqbot-inbound-mirror.mjs';
import { readJsonlTail } from '../state.mjs';
import { clip, str } from '../small-utils.mjs';

const stripMention = (t) => String(t)
  .replace(/<@!?[0-9A-Za-z]+>/g, '')
  .replace(/\(@you\)/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Mirror inbound row → im-chat entry fields. Owner labeling matches the transcript path. */
export function mirrorRowToImEntry(row, { ownerId = '' } = {}) {
  const kind = row.kind === 'group' ? 'group' : 'c2c';
  const senderId = str(row.senderId).toUpperCase();
  const isOwner = Boolean(ownerId) && senderId === ownerId;
  const label = kind === 'group'
    ? (isOwner ? '主人' : (str(row.senderName) || '群友'))
    : (str(row.senderName) || '主人');
  return {
    platform: 'qq',
    peerId: str(row.targetId),
    peerLabel: label,
    groupId: kind === 'group' ? str(row.targetId) : '',
    role: 'user',
    text: clip(stripMention(str(row.text)), 1800),
    at: str(row.at) || new Date().toISOString(),
    messageId: str(row.msgId),
    media: Array.isArray(row.attachments) ? row.attachments : [],
    senderId,
    senderName: str(row.senderName),
    isOwner,
  };
}

/** True when the transcript scan already imported this platform message (real id match). */
export function getSeenRealIds(cursor) {
  const list = Array.isArray(cursor?.seenRealIds) ? cursor.seenRealIds : [];
  return new Set(list.map((v) => str(v)).filter(Boolean));
}

export function rememberRealId(cursor, msgId) {
  if (!msgId) return;
  const list = Array.isArray(cursor.seenRealIds) ? cursor.seenRealIds : [];
  if (list.includes(msgId)) return;
  list.push(msgId);
  cursor.seenRealIds = list.slice(-400);
}

/**
 * Import live mirror rows into the timeline. Returns touched conversation keys
 * (`group:<id>` / `c2c:<id>`) plus counts; advances `cursor.liveAt` / `seenRealIds`.
 */
export async function importLiveQqInbound(home, cursor, { ownerId = '', warn = () => {} } = {}) {
  const rows = await readQqInboundSince(str(cursor.liveAt));
  const seen = getSeenRealIds(cursor);
  const touched = new Set();
  let imported = 0;
  let lastAt = str(cursor.liveAt);
  for (const row of rows) {
    const receivedAt = str(row.receivedAt || row.at);
    if (receivedAt > lastAt) lastAt = receivedAt;
    const msgId = str(row.msgId);
    if (!msgId || seen.has(msgId) || row.senderIsBot === true) continue;
    const entry = mirrorRowToImEntry(row, { ownerId });
    if (!entry.text.trim() && !entry.media.length) continue;
    const res = await appendImChat(home, entry).catch(() => null);
    if (!res?.ok) continue;
    rememberRealId(cursor, msgId);
    touched.add(entry.groupId ? `group:${entry.groupId}` : `c2c:${entry.peerId}`);
    imported += 1;
    if (entry.isOwner) {
      await appendJsonl(join(home.rootDir, 'logs', 'interactions.jsonl'), {
        at: entry.at, action: 'chat', via: 'qq',
      }).catch(() => {});
    }
  }
  if (lastAt) cursor.liveAt = lastAt;

  // Outbound proactive sends (media included) — the transcript never sees these.
  const outRows = await readJsonlTail(qqOutboundPath(), 200).catch(() => []);
  const outSeen = new Set(Array.isArray(cursor.seenOutIds) ? cursor.seenOutIds : []);
  let outImported = 0;
  for (const row of outRows) {
    const id = str(row?.messageId);
    if (!id || outSeen.has(id)) continue;
    const kind = row.kind === 'group' ? 'group' : 'c2c';
    const res = await appendImChat(home, {
      platform: 'qq',
      peerId: str(row.targetId),
      peerLabel: '我',
      groupId: kind === 'group' ? str(row.targetId) : '',
      role: 'bot',
      text: str(row.text),
      at: str(row.at),
      messageId: id,
      media: str(row.mediaType) ? [{ contentType: str(row.mediaType), url: '' }] : [],
    }).catch(() => null);
    outSeen.add(id);
    if (res?.ok) {
      outImported += 1;
      touched.add(kind === 'group' ? `group:${row.targetId}` : `c2c:${row.targetId}`);
    }
  }
  cursor.seenOutIds = [...outSeen].slice(-400);
  return { imported: imported + outImported, touched };
}

const LIFECYCLE_LABELS = {
  GROUP_ADD_ROBOT: '被拉进了一个新群',
  GROUP_DEL_ROBOT: '被移出了一个群',
  GROUP_MSG_REJECT: '群消息被拒收（对方关闭了接收）',
  GROUP_MSG_RECEIVE: '群消息恢复接收',
  FRIEND_ADD: '有新好友添加了 Bot',
  FRIEND_DEL: '有好友删除了 Bot',
  C2C_MSG_REJECT: '私聊消息被拒收',
  C2C_MSG_RECEIVE: '私聊消息恢复接收',
};

/**
 * Lifecycle events → activity journal + pushEvent (a new group should surface at once,
 * not wait for someone to speak). Button interactions → journal for the panel/tools.
 */
export async function importQqLifecycleAndInteractions(home, cursor, { pushEvent = () => 0 } = {}) {
  const events = await readJsonlTail(qqLifecyclePath(), 100).catch(() => []);
  const seen = new Set(Array.isArray(cursor.seenLifecycle) ? cursor.seenLifecycle : []);
  let count = 0;
  for (const row of events) {
    const key = `${str(row?.at)}|${str(row?.type)}|${str(row?.groupOpenid || row?.openid)}`;
    if (!row?.type || seen.has(key)) continue;
    seen.add(key);
    count += 1;
    await appendJsonl(join(home.rootDir, 'logs', 'qq-lifecycle-seen.jsonl'), row).catch(() => {});
    const label = LIFECYCLE_LABELS[str(row.type)] || str(row.type);
    try {
      pushEvent('qq-lifecycle', {
        type: str(row.type),
        label,
        groupId: str(row.groupOpenid),
        openid: str(row.openid || row.memberOpenid),
      });
    } catch { /* optional */ }
  }
  cursor.seenLifecycle = [...seen].slice(-300);

  const interactions = await readJsonlTail(qqInteractionsPath(), 100).catch(() => []);
  const iSeen = new Set(Array.isArray(cursor.seenInteractions) ? cursor.seenInteractions : []);
  let buttons = 0;
  for (const row of interactions) {
    const id = str(row?.id);
    if (!id || iSeen.has(id)) continue;
    iSeen.add(id);
    buttons += 1;
    await appendJsonl(join(home.rootDir, 'logs', 'qq-buttons.jsonl'), row).catch(() => {});
    try {
      pushEvent('qq-button', {
        buttonData: str(row.buttonData),
        groupId: str(row.groupOpenid),
        openid: str(row.userOpenid || row.memberOpenid),
      });
    } catch { /* optional */ }
  }
  cursor.seenInteractions = [...iSeen].slice(-300);
  return { lifecycle: count, buttons };
}