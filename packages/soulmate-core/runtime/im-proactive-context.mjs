// IM proactive context: what she actually knows about a conversation before speaking
// first. The 2026-11-25 group incident ("刚看见那群傻鸟又在瞎起哄" with nobody talking)
// came from authoring with ZERO recent context — the model staged the persona's
// catchphrase examples as real events. Every proactive line is now grounded in the
// real timeline: group + owner DM + her memory digest (user decision 2026-11-25).
import { listImChat } from '../im-chat.mjs';
import { readEpisodes, upsertSessionEpisode } from '../memory-engine.mjs';
import { listSurfLog } from '../surf-log.mjs';
import { describeAttachments, readQqVisionDescriptions } from './qq-vision-runtime.mjs';
import { clip, str } from '../small-utils.mjs';

const MINUTE = 60_000;

/**
 * Transcript rows arrive as plumbing, not speech: `<faceType=…>` XML, bare
 * `- Image: C:/…` host paths. Render them as what a human would see.
 */
export function cleanImRowText(text) {
  let t = str(text);
  t = t.replace(/^- Image:.*$/gm, '');
  t = t.replace(/<faceType=[^>]*ext="([A-Za-z0-9+/=]*)"[^>]*>/g, (_m, b64) => {
    try {
      const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const name = str(j?.text).trim();
      return name ? `[表情:${name}]` : '[表情]';
    } catch { return '[表情]'; }
  });
  t = t.replace(/<faceType=[^>]*>/g, '[表情]');
  return t.replace(/\n{2,}/g, '\n').trim();
}

const hhmm = (atMs, tz) => {
  const d = new Date(atMs + tz * MINUTE);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** Newest-first im-chat rows → one readable line each, oldest-first block. */
export function renderImContextRows(rows, { tzOffsetMinutes = 480, ownerId = '', ownerName = '', vision = {}, maxLineChars = 90, isGroup = false } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => Date.parse(a?.at) - Date.parse(b?.at));
  const lines = [];
  for (const r of list) {
    const t = Date.parse(r?.at);
    if (!Number.isFinite(t)) continue;
    const media = describeAttachments(r?.media, { descriptions: vision });
    const text = [cleanImRowText(r?.text), media].filter(Boolean).join(' ');
    if (!text) continue;
    let who;
    if (r.role === 'bot') who = '我';
    else if (ownerId && str(r.senderId).toUpperCase() === ownerId) who = str(r.senderName) || ownerName || '他';
    else who = str(r.senderName) || str(r.peerLabel) || (isGroup ? '群友' : '他');
    lines.push(`${hhmm(t, tzOffsetMinutes)} ${who}：${clip(text, maxLineChars)}`);
  }
  return lines.join('\n');
}

const ageLabel = (atMs, nowMs) => {
  const mins = Math.max(0, Math.round((nowMs - atMs) / MINUTE));
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
};

/**
 * Fresh real material she can bring up as a NEW topic (user decision 2026-11-25:
 * high autonomy — new topics / news / free chat allowed, but only from real finds).
 * Today's watched-video notes first; her IM memory stars as background.
 */
export async function composeImTopicMaterial(home, { nowMs = Date.now(), maxItems = 3 } = {}) {
  const bits = [];
  try {
    const seen = await listSurfLog(home, { platform: 'bilibili', limit: 12 });
    const fresh = seen.filter((e) => nowMs - (Date.parse(e.at) || 0) < 24 * 60 * MINUTE && (str(e.summary) || str(e.title)));
    for (const e of fresh.slice(0, maxItems)) {
      bits.push(clip(`看过的视频《${str(e.title)}》：${str(e.summary) || '（只有标题）'}`, 110));
    }
  } catch { /* surf log optional */ }
  return bits.join('\n');
}

/**
 * The full brief for one proactive target: recent target-conversation lines, the
 * owner's DM lines (even when speaking to a group), her memory digest, and fresh
 * real material for new topics. Group privacy rule: DM lines may inform tone but
 * must not be quoted in the group.
 */
export async function composeImProactiveContext(home, {
  target = {}, ext = {}, nowMs = Date.now(), tzOffsetMinutes = 480,
  recentLines = 10, dmLines = 6, memory = '',
} = {}) {
  const platform = str(target.platform) || 'qq';
  const ownerId = str(ext.imOwnerQq).trim().toUpperCase();
  const vision = platform === 'qq' ? await readQqVisionDescriptions(home).catch(() => ({})) : {};
  const render = (rows, isGroup) => renderImContextRows(rows, { tzOffsetMinutes, ownerId, vision, isGroup });

  const targetRows = target.groupId
    ? await listImChat(home, { platform, groupId: target.groupId, limit: recentLines }).catch(() => [])
    : await listImChat(home, { platform, peerId: target.to, limit: recentLines }).catch(() => []);
  const recent = render(targetRows, Boolean(target.groupId));
  const newest = (Array.isArray(targetRows) ? targetRows : []).reduce((m, r) => Math.max(m, Date.parse(r?.at) || 0), 0);
  const lastActivity = newest ? ageLabel(newest, nowMs) : '';

  // The owner's private thread on the same platform — skipped when it IS the target.
  let dm = '';
  if (ownerId && platform === 'qq' && str(target.to) !== ownerId) {
    const dmRows = await listImChat(home, { platform, peerId: ownerId, limit: dmLines }).catch(() => []);
    dm = render(dmRows, false);
  }
  const material = await composeImTopicMaterial(home, { nowMs }).catch(() => '');
  return { recent, dm, memory: str(memory), material, lastActivity };
}

/**
 * Refresh the conversation's memory star from the im-chat timeline — one shared
 * implementation for the proactive send and the bridge import (they drifted:
 * the proactive copy ignored vision/media and mislabeled every group speaker).
 */
export async function refreshImMemoryStar(home, { platform = 'qq', groupId = '', peerId = '', label = '', limit = 40, tzOffsetMinutes = 480, ownerId = '', nowMs = Date.now() } = {}) {
  const id = str(groupId) || str(peerId);
  if (!id) return { ok: false, error: 'groupId or peerId required' };
  const rows = groupId
    ? await listImChat(home, { platform, groupId, limit }).catch(() => [])
    : await listImChat(home, { platform, peerId: id, limit }).catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'empty-thread' };
  const vision = platform === 'qq' ? await readQqVisionDescriptions(home).catch(() => ({})) : {};
  const content = renderImContextRows(rows, { tzOffsetMinutes, ownerId, vision, isGroup: Boolean(groupId) });
  if (!content) return { ok: false, error: 'empty-content' };
  return upsertSessionEpisode(home, {
    sessionId: groupId ? `im:group:${platform}:${groupId}` : `im:${platform}:${id}`,
    title: groupId ? `${platform}群 · ${label || groupId}` : `${platform} · ${label || id}`,
    content,
    kind: 'im',
    nowMs,
  });
}

/** IM memory stars (kind 'im'), newest first — the star-map record of her conversations. */
export async function listImMemoryStars(home, { limit = 8 } = {}) {
  const eps = await readEpisodes(home, { includePrivate: false }).catch(() => []);
  return eps
    .filter((e) => e.kind === 'im' && str(e.sessionId).startsWith('im:'))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(1, limit));
}