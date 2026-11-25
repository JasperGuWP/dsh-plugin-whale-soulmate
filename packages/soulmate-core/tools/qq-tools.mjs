// Official QQ channel tools: rich media send, recall, typing, wakeup, buttons and
// recent button clicks / lifecycle events. These ride the OFFICIAL bot (profile
// credentials + SDK msg-id mirror), independent of the built-in soulmate-im channels.

import { readJsonlTail, loadConfig } from '../state.mjs';
import { readQqReplyIds } from '../qqbot-msgid-mirror.mjs';
import { qqInteractionsPath, qqLifecyclePath } from '../qqbot-inbound-mirror.mjs';
import { str } from '../small-utils.mjs';

export function qqTools({ makeTool, home, pushEvent, qqOps }) {
  const ops = () => (qqOps && typeof qqOps.sendMedia === 'function' ? qqOps : null);
  const noOps = { ok: false, error: 'official qq ops unavailable (bridge not mounted)' };

  /** Default target = the owner's c2c openid from config. */
  async function defaultTo() {
    const conf = await loadConfig(home).catch(() => null);
    return str(conf?.extensions?.imOwnerQq).trim();
  }

  const tools = [
    makeTool({
      name: 'soulmate_qq_send_media',
      timeoutMs: 90_000,
      description:
        'Send an image / video / voice / file through the OFFICIAL QQ bot to a private chat (to = openid) or group (groupId). ' +
        'Requires the passive-reply window (group 5min / c2c 30min after their last message). ' +
        'Provide url (public https) OR filePath (local file). Voice must be silk/wav the platform accepts. ' +
        'caption is optional text sent with the media; it passes the privacy firewall.',
      parameters: {
        mediaType: { type: 'string', required: true, enum: ['image', 'video', 'voice', 'file'], description: 'image | video | voice | file' },
        url: { type: 'string', description: 'Public media URL (mutually exclusive with filePath).' },
        filePath: { type: 'string', description: 'Local file path to upload (mutually exclusive with url).' },
        to: { type: 'string', description: 'c2c recipient openid. Default: the owner (imOwnerQq).' },
        groupId: { type: 'string', description: 'Send to this group instead of a private chat.' },
        caption: { type: 'string', description: 'Optional caption text.' },
      },
      async run(args) {
        const o = ops();
        if (!o) return noOps;
        const to = str(args.to).trim() || (args.groupId ? '' : await defaultTo());
        const res = await o.sendMedia({
          target: { to, groupId: str(args.groupId).trim() },
          mediaType: str(args.mediaType),
          url: str(args.url).trim(),
          filePath: str(args.filePath).trim(),
          caption: str(args.caption),
        });
        if (res.ok) pushEvent('im_send', { platform: 'qq', mediaType: res.mediaType });
        return res;
      },
    }),

    makeTool({
      name: 'soulmate_qq_recall',
      description:
        'Recall (delete) a message the official QQ bot sent. messageId comes from a previous send result ' +
        'or the QQ timeline. target: to (openid, default owner) or groupId.',
      parameters: {
        messageId: { type: 'string', required: true, description: 'Platform message id of the bot message to recall.' },
        to: { type: 'string', description: 'c2c openid. Default: the owner.' },
        groupId: { type: 'string', description: 'Group openid when recalling a group message.' },
      },
      async run(args) {
        const o = ops();
        if (!o) return noOps;
        const to = str(args.to).trim() || (args.groupId ? '' : await defaultTo());
        return o.recall({ target: { to, groupId: str(args.groupId).trim() }, messageId: str(args.messageId) });
      },
    }),

    makeTool({
      name: 'soulmate_qq_typing',
      description:
        'Show the「正在输入…」typing indicator in a QQ private chat (c2c only, needs an open passive window). ' +
        'Use right before composing a longer reply so the owner sees you are writing.',
      parameters: {
        to: { type: 'string', description: 'c2c openid. Default: the owner.' },
        seconds: { type: 'number', description: 'Indicator duration, 1-60 (default 30).' },
      },
      async run(args) {
        const o = ops();
        if (!o) return noOps;
        const to = str(args.to).trim() || await defaultTo();
        return o.typing({ to, seconds: Number(args.seconds) || 30 });
      },
    }),

    makeTool({
      name: 'soulmate_qq_wakeup',
      timeoutMs: 30_000,
      description:
        'Legal OUT-OF-WINDOW proactive push to a QQ private chat: the platform wakeup recall ' +
        '(within 30 days after the user initiated contact; QQ caps the frequency — a refusal is honest, do not retry-loop). ' +
        'Use sparingly for a genuinely worth-saying line. Text passes the privacy firewall.',
      parameters: {
        text: { type: 'string', required: true, description: 'The message, in her own voice.' },
        to: { type: 'string', description: 'c2c openid. Default: the owner.' },
      },
      async run(args) {
        const o = ops();
        if (!o) return noOps;
        const to = str(args.to).trim() || await defaultTo();
        const res = await o.wakeup({ to, text: str(args.text) });
        if (res.ok) pushEvent('im_send', { platform: 'qq', mode: 'wakeup' });
        return res;
      },
    }),

    makeTool({
      name: 'soulmate_qq_buttons',
      timeoutMs: 30_000,
      description:
        'Send a QQ text message with inline buttons (max 5). Needs an open passive window. ' +
        'Clicks arrive as interactions — read them with soulmate_qq_events. ' +
        'Each button: { label (shown text), data (payload returned on click) }.',
      parameters: {
        text: { type: 'string', required: true, description: 'Message body above the buttons.' },
        buttons: { type: 'array', required: true, items: { type: 'object' }, description: '[{label, data}] — up to 5.' },
        to: { type: 'string', description: 'c2c openid. Default: the owner.' },
        groupId: { type: 'string', description: 'Group openid for a group message.' },
      },
      async run(args) {
        const o = ops();
        if (!o) return noOps;
        const to = str(args.to).trim() || (args.groupId ? '' : await defaultTo());
        return o.sendButtons({
          target: { to, groupId: str(args.groupId).trim() },
          text: str(args.text),
          buttons: Array.isArray(args.buttons) ? args.buttons : [],
        });
      },
    }),

    makeTool({
      name: 'soulmate_qq_stream',
      timeoutMs: 120_000,
      description:
        'Send a QQ PRIVATE-chat message with a live typing-out effect (official stream_messages, ' +
        'markdown, replace frames). Needs an open passive window. The full text is streamed in ' +
        'chunks; the final frame lands as one message. Text passes the privacy firewall.',
      parameters: {
        text: { type: 'string', required: true, description: 'The full message (markdown allowed).' },
        to: { type: 'string', description: 'c2c openid. Default: the owner.' },
        chunkChars: { type: 'number', description: 'Chars per frame (default 24; frames ≥400ms apart).' },
      },
      async run(args) {
        const o = ops();
        if (!o || typeof o.streamText !== 'function') return noOps;
        const to = str(args.to).trim() || await defaultTo();
        const res = await o.streamText({ to, text: str(args.text), chunkChars: Number(args.chunkChars) || 24 });
        if (res.ok) pushEvent('im_send', { platform: 'qq', mode: 'stream' });
        return res;
      },
    }),

    makeTool({
      name: 'soulmate_qq_events',
      description:
        'Recent official-QQ happenings: button clicks (interactions), lifecycle events ' +
        '(bot added to / removed from a group, friend added/deleted, message receive toggles), ' +
        'and whether the passive-reply window is currently open for a target. Read-only.',
      parameters: {
        kind: { type: 'string', enum: ['buttons', 'lifecycle', 'window', 'all'], description: 'Default all.' },
        to: { type: 'string', description: 'window: c2c openid (default owner).' },
        groupId: { type: 'string', description: 'window: group openid.' },
        limit: { type: 'number', description: 'Max rows per list (default 10).' },
      },
      async run(args) {
        const kind = str(args.kind) || 'all';
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const out = { ok: true };
        if (kind === 'all' || kind === 'buttons') {
          out.buttons = (await readJsonlTail(qqInteractionsPath(), limit).catch(() => [])).reverse();
        }
        if (kind === 'all' || kind === 'lifecycle') {
          out.lifecycle = (await readJsonlTail(qqLifecyclePath(), limit).catch(() => [])).reverse();
        }
        if (kind === 'all' || kind === 'window') {
          const groupId = str(args.groupId).trim();
          const to = str(args.to).trim() || (groupId ? '' : await defaultTo());
          const scope = groupId ? 'group' : 'c2c';
          const targetId = groupId || to;
          const ids = targetId ? await readQqReplyIds(scope, targetId).catch(() => []) : [];
          out.window = {
            scope, targetId, open: ids.length > 0, freshIds: ids.length,
            note: ids.length ? '被动窗口开着，可以主动发' : '被动窗口关闭：群5分钟/私聊30分钟内对方没说话（私聊仍可尝试 wakeup）',
          };
        }
        return out;
      },
    }),
  ];

  return { tools };
}