// IM chat timeline API for DsBot panel.

import { jsonOut } from '../http-plumbing.mjs';
import { listImChat, listImContacts } from '../im-chat.mjs';
import { listKnownImConversations, readQqSpeakerNames } from '../im-known.mjs';
import { readQqVisionDescriptions } from '../runtime/qq-vision-runtime.mjs';
import { readJsonlTail } from '../state.mjs';
import { join } from 'node:path';

export function imChatRoutes({ home }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/im/chat'],
      handler: async ({ query }) => {
        const platform = String(query.get('platform') || 'weixin').trim() || 'weixin';
        const peer = String(query.get('peer') || '').trim();
        const limit = Number(query.get('limit')) || 50;
        const before = String(query.get('before') || '').trim();
        const contacts = await listImContacts(home, { platform, limit: 80 });
        // A group contact's peerId is the group id — load its thread by groupId.
        const contact = contacts.find((c) => c.peerId === peer);
        const messages = peer
          ? await listImChat(home, contact?.groupId
            ? { platform, groupId: contact.groupId, limit, before }
            : { platform, peerId: peer, limit, before })
          : [];
        // QQ images: attach the vision description so the bubble reads [图片] 描述.
        if (platform === 'qq' && messages.some((m) => m.media?.length)) {
          const descriptions = await readQqVisionDescriptions(home).catch(() => ({}));
          for (const m of messages) {
            for (const item of m.media || []) {
              if (descriptions[item.url]) item.description = descriptions[item.url];
            }
          }
        }
        // Panel wants chronological bubbles (oldest → newest)
        const chronological = messages.slice().reverse();
        return jsonOut(200, { ok: true, platform, peer, contacts, messages: chronological });
      },
    },
    {
      // IM 主动搭话白名单「从最近会话选」：QQ 官方 prefs + 各平台 im-chat 台账。
      method: 'GET',
      paths: ['/dsh-soulmate/api/im/known'],
      handler: async () => {
        const conversations = await listKnownImConversations(home);
        // QQ speaker candidates for the owner-id picker: openid → real nickname.
        const names = await readQqSpeakerNames().catch(() => new Map());
        const speakers = [...names.entries()].map(([id, name]) => ({ platform: 'qq', id, name }));
        return jsonOut(200, { ok: true, conversations, speakers });
      },
    },
    {
      // QQ 官方通道动态：拉群/加好友等生命周期事件 + 按钮点击（镜像日志，只读）。
      method: 'GET',
      paths: ['/dsh-soulmate/api/qqbot/events'],
      handler: async ({ query }) => {
        const limit = Math.min(50, Math.max(1, Number(query.get('limit')) || 20));
        const lifecycle = (await readJsonlTail(join(home.rootDir, 'logs', 'qq-lifecycle.jsonl'), limit).catch(() => [])).reverse();
        const buttons = (await readJsonlTail(join(home.rootDir, 'logs', 'qq-interactions.jsonl'), limit).catch(() => [])).reverse();
        return jsonOut(200, { ok: true, lifecycle, buttons });
      },
    },
  ];
}
