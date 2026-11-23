// 从各 IM 通道「当前实际情况」收集可加白的会话，供 IM 主动搭话白名单一键填入。
// QQ 官方 Bot：读官方包持久化的 ~/.dsh-qqbot/model-prefs.json（sessionIds 键含 openid）。
// 其余平台：soulmate 自己的 im-chat 台账（最近聊过的对方/群）。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listImContacts } from './im-chat.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 解析官方 QQ Bot 的 model-prefs.json。
 * 键形如 qqbot:<appId>:c2c:<user_openid> / qqbot:<appId>:group:<group_openid>。
 * 纯函数，便于单测。
 */
export function parseQqbotPrefs(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return []; }
  }
  const ids = data && typeof data === 'object' && data.sessionIds && typeof data.sessionIds === 'object'
    ? data.sessionIds
    : {};
  const out = [];
  const seen = new Set();
  for (const key of Object.keys(ids)) {
    const m = /^qqbot:([^:]+):(c2c|group):(.+)$/.exec(str(key).trim());
    if (!m) continue;
    const [, appId, scope, openid] = m;
    if (!openid) continue;
    const dedupe = `${scope}:${openid}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      platform: 'qq',
      to: scope === 'c2c' ? openid : '',
      groupId: scope === 'group' ? openid : '',
      label: `${scope === 'group' ? 'QQ群' : 'QQ私聊'} ${openid.slice(0, 6)}…`,
      source: 'qqbot-prefs',
      appId,
    });
  }
  return out;
}

export async function readQqbotKnownConversations({ readFileImpl, homeDir } = {}) {
  const read = typeof readFileImpl === 'function' ? readFileImpl : (p) => readFile(p, 'utf8');
  const path = join(homeDir || homedir(), '.dsh-qqbot', 'model-prefs.json');
  try {
    return parseQqbotPrefs(await read(path));
  } catch {
    return [];
  }
}

/**
 * 汇总可加白会话：QQ 官方 prefs + 各平台 im-chat 最近联系人。
 * 返回 [{ platform, to, groupId, label, source, lastAt? }]，QQ prefs 在前。
 */
export async function listKnownImConversations(home, { readFileImpl, homeDir, limit = 40 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const key = `${c.platform}:${c.groupId || ''}:${c.to || ''}`;
    if (!c.to && !c.groupId) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const c of await readQqbotKnownConversations({ readFileImpl, homeDir })) push(c);
  for (const platform of ['qq', 'weixin', 'feishu', 'dingtalk']) {
    try {
      const contacts = await listImContacts(home, { platform, limit: 20 });
      for (const c of contacts) {
        push({
          platform,
          to: str(c.peerId),
          groupId: '',
          label: str(c.peerLabel || c.peerId).slice(0, 24),
          source: 'im-chat',
          lastAt: str(c.lastAt),
        });
      }
    } catch { /* 平台无台账则跳过 */ }
  }
  return out.slice(0, Math.max(1, Math.floor(Number(limit) || 40)));
}