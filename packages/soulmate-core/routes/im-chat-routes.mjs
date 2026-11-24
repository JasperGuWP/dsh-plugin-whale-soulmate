// IM chat timeline API for DsBot panel.

import { jsonOut } from '../http-plumbing.mjs';
import { listImChat, listImContacts } from '../im-chat.mjs';
import { listKnownImConversations, readQqSpeakerNames } from '../im-known.mjs';

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
  ];
}
