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
  // Transcript imports embed the speaker tag in the text: `[等风 (openid)] …`.
  t = t.replace(/\[[^\[\]()]{1,24}\s*\([0-9A-Fa-f]{16,}\)\]\s*/g, '');
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

/** Speaker tag inside imported transcript text → { name, openid } (empty when absent). */
export function extractSpeakerTag(text) {
  const m = /\[([^\[\]()]{1,24})\s*\(([0-9A-Fa-f]{16,})\)\]/.exec(str(text));
  return m ? { name: m[1].trim(), openid: m[2].toUpperCase() } : { name: '', openid: '' };
}

const hhmm = (atMs, tz) => {
  const d = new Date(atMs + tz * MINUTE);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

// Older lines carry MM-DD: yesterday's "17:37" read as today's fresh gossip otherwise.
const dayKey = (atMs, tz) => {
  const d = new Date(atMs + tz * MINUTE);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

/** Newest-first im-chat rows → one readable line each, oldest-first block. */
export function renderImContextRows(rows, { tzOffsetMinutes = 480, nowMs = Date.now(), ownerId = '', ownerName = '', vision = {}, maxLineChars = 90, isGroup = false } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => Date.parse(a?.at) - Date.parse(b?.at));
  const today = dayKey(nowMs, tzOffsetMinutes);
  const lines = [];
  const seen = [];
  for (const r of list) {
    const t = Date.parse(r?.at);
    if (!Number.isFinite(t)) continue;
    const media = describeAttachments(r?.media, { descriptions: vision });
    const text = [cleanImRowText(r?.text), media].filter(Boolean).join(' ');
    if (!text) continue;
    let who;
    if (r.role === 'bot') who = '我';
    else {
      // Transcript-import rows lack senderId but carry `[名字 (openid)]` in the text.
      const tag = extractSpeakerTag(r?.text);
      const sid = str(r.senderId).toUpperCase() || tag.openid;
      const named = str(r.senderName) || tag.name;
      if (ownerId && sid === ownerId) who = named || ownerName || '主人';
      else who = named || str(r.peerLabel) || (isGroup ? '群友' : '他');
    }
    // Live-mirror + transcript-import twins: same speaker/words seconds apart, one
    // row lacking senderId. Collapse to ONE line; the identified twin wins the label.
    const rich = Boolean(str(r.senderId) || extractSpeakerTag(r?.text).openid);
    const dup = seen.find((s) => s.role === r.role && s.text === text && Math.abs(s.t - t) <= 5000);
    const stamp = dayKey(t, tzOffsetMinutes) === today ? hhmm(t, tzOffsetMinutes) : `${dayKey(t, tzOffsetMinutes)} ${hhmm(t, tzOffsetMinutes)}`;
    const line = `${stamp} ${who}：${clip(text, maxLineChars)}`;
    if (dup) {
      if (!dup.rich && rich) { lines[dup.index] = line; dup.rich = true; }
      continue;
    }
    seen.push({ role: r.role, text, t, index: lines.length, rich });
    lines.push(line);
  }
  return lines.join('\n');
}

const ageLabel = (atMs, nowMs) => {
  const mins = Math.max(0, Math.round((nowMs - atMs) / MINUTE));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
};

// 哪天 + 几点（本地）。见闻不带日期时，16 小时前看的片子会被说成「刚啃完」；
// 主动消息里每个时间事实都必须是可以被读出来的，而不是模型自己估的。
const dayWord = (atMs, nowMs, tzOffsetMinutes) => {
  const key = (ms) => {
    const d = new Date(ms + tzOffsetMinutes * MINUTE);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  };
  const at = key(atMs);
  if (at === key(nowMs)) return '今天';
  if (at === key(nowMs - 86_400_000)) return '昨天';
  return dayKey(atMs, tzOffsetMinutes);
};

/** "昨天 18:16，16 小时前" — the only time wording the proactive prompt may quote. */
export function describeMoment(atMs, nowMs = Date.now(), tzOffsetMinutes = 480) {
  return `${dayWord(atMs, nowMs, tzOffsetMinutes)} ${hhmm(atMs, tzOffsetMinutes)}，${ageLabel(atMs, nowMs)}`;
}

/**
 * Fresh real material she can bring up as a NEW topic (user decision 2026-11-25:
 * high autonomy — new topics / news / free chat allowed, but only from real finds).
 * Today's watched-video notes first; her IM memory stars as background.
 * Each find carries WHEN it happened: the model used to read a 16-hour-old video as
 * "刚啃完" because the brief had no timestamp.
 */
export async function composeImTopicMaterial(home, { nowMs = Date.now(), maxItems = 3, tzOffsetMinutes = 480, windowHours = 24 } = {}) {
  const bits = [];
  try {
    const seen = await listSurfLog(home, { platform: 'bilibili', limit: 12 });
    const windowMs = Math.max(1, Number(windowHours) || 24) * 60 * MINUTE;
    const fresh = seen.filter((e) => {
      const at = Date.parse(e.at);
      return Number.isFinite(at) && nowMs - at < windowMs && (str(e.summary) || str(e.title));
    });
    for (const e of fresh.slice(0, maxItems)) {
      const when = describeMoment(Date.parse(e.at), nowMs, tzOffsetMinutes);
      bits.push(clip(`看过的视频《${str(e.title)}》（${when}看的）：${str(e.summary) || '（只有标题）'}`, 140));
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
  const render = (rows, isGroup) => renderImContextRows(rows, { tzOffsetMinutes, nowMs, ownerId, vision, isGroup });

  const targetRows = target.groupId
    ? await listImChat(home, { platform, groupId: target.groupId, limit: recentLines }).catch(() => [])
    : await listImChat(home, { platform, peerId: target.to, limit: recentLines }).catch(() => []);
  const recent = render(targetRows, Boolean(target.groupId));
  // "He last spoke" — the bot's own proactive lines must not masquerade as his activity,
  // or a fresh self-sent message reads as "he was just here".
  const newest = (Array.isArray(targetRows) ? targetRows : []).reduce(
    (m, r) => (r?.role === 'bot' ? m : Math.max(m, Date.parse(r?.at) || 0)),
    0,
  );
  const lastActivity = newest ? ageLabel(newest, nowMs) : '';

  // The owner's private thread on the same platform — skipped when it IS the target.
  let dm = '';
  if (ownerId && platform === 'qq' && str(target.to) !== ownerId) {
    const dmRows = await listImChat(home, { platform, peerId: ownerId, limit: dmLines }).catch(() => []);
    dm = render(dmRows, false);
  }
  const material = await composeImTopicMaterial(home, { nowMs, tzOffsetMinutes }).catch(() => '');
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
  const content = renderImContextRows(rows, { tzOffsetMinutes, nowMs, ownerId, vision, isGroup: Boolean(groupId) });
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