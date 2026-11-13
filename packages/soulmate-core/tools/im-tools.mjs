// Model tools + wiring for the four built-in IM channels (WeChat / QQ / Feishu / DingTalk).
// IM replies are user-initiated, so they are *recorded* but never refused by the cap:
// the person on the other end is waiting. The wrapper exists purely for accounting.

import { IM_MANAGE_ACTIONS, IM_PLATFORMS, manageIm, sendImMessage, startWeixinPollLoop } from '../../soulmate-im/index.mjs';
import { str } from '../small-utils.mjs';

export function imTools({ makeTool, service, home, cfg, ctx, pushEvent, warn, track, meteredCall }) {
  const meteredImGenerator = (inner) => async (payload) => {
    const res = await meteredCall({
      kind: 'im',
      trigger: 'user',
      prompt: str(payload?.text ?? payload?.content ?? ''),
      call: () => inner(payload),
    });
    return res.ok ? res.out : undefined;
  };

  const imNet = () => ({
    ...(cfg.imFetch ? { fetchImpl: cfg.imFetch } : {}),
    ...(cfg.imReplyGenerator ? { replyGenerator: meteredImGenerator(cfg.imReplyGenerator) } : {}),
    ...(cfg.imMemoryVisibility ? { memoryVisibility: cfg.imMemoryVisibility } : {}),
    // an optional host session controller can author the replies (falls back to the persona template)
    sessionController: imSessionController(),
  });

  /** Wrap the host controller so IM-authored replies are metered too (still user-initiated). */
  function imSessionController() {
    const controller = ctx.get?.('sessionController') ?? undefined;
    if (!controller || typeof controller.generateReply !== 'function') return controller;
    return {
      ...controller,
      generateReply: (payload) => meteredImGenerator((p) => controller.generateReply(p))(payload),
    };
  }

  const tools = [
    makeTool({
      name: 'soulmate_im_send',
      description:
        'Proactively send an in-character message to the user on WeChat (个人微信), QQ (OneBot/Official), Feishu (飞书), or DingTalk (钉钉). ' +
        'The text passes the privacy firewall first (secrets are refused, local paths / emails / phones are scrubbed). ' +
        '`to` defaults to the owner of the channel (WeChat: the account that scanned the QR code).',
      parameters: {
        platform: { type: 'string', required: true, enum: [...IM_PLATFORMS], description: 'weixin | qq | feishu | dingtalk' },
        text: { type: 'string', required: true, description: 'The message to send, written in her own voice.' },
        to: { type: 'string', description: 'Recipient id (WeChat user id / QQ number or openid / Feishu open_id / DingTalk staffId). Default: the channel owner.' },
        groupId: { type: 'string', description: 'qq: send to this group instead of a private chat.' },
        receiveIdType: { type: 'string', enum: ['open_id', 'user_id', 'union_id', 'email', 'chat_id'], description: 'feishu: type of `to` (default open_id).' },
        sessionWebhook: { type: 'string', description: 'dingtalk: reply through this session webhook.' },
        openConversationId: { type: 'string', description: 'dingtalk: send into this group conversation.' },
        title: { type: 'string', description: 'dingtalk: when set, send as a markdown message with this title.' },
      },
      async run(args) {
        const res = await sendImMessage(
          home,
          args.platform,
          {
            text: args.text,
            to: args.to,
            groupId: args.groupId,
            receiveIdType: args.receiveIdType,
            sessionWebhook: args.sessionWebhook,
            openConversationId: args.openConversationId,
            title: args.title,
          },
          imNet()
        );
        if (res.ok) pushEvent('im_send', { platform: res.platform });
        return res;
      },
    }),

    makeTool({
      name: 'soulmate_im_manage',
      timeoutMs: 60_000,
      description:
        'Check status, start WeChat QR login, poll updates, or configure built-in IM channels (weixin / qq / feishu / dingtalk). ' +
        'status = masked overview; configure = save credentials (stored only in credentials.json, never echoed) + enable/disable + whitelist; ' +
        'weixin_qr_start / weixin_qr_poll = personal WeChat QR login; weixin_poll = pull new WeChat messages once and answer them; ' +
        'stream_ticket = open a DingTalk Stream gateway ticket.',
      parameters: {
        action: { type: 'string', enum: [...IM_MANAGE_ACTIONS], description: `${IM_MANAGE_ACTIONS.join(' | ')} (default status).` },
        platform: { type: 'string', enum: [...IM_PLATFORMS], description: 'configure: which platform.' },
        credentials: {
          type: 'object',
          description:
            'configure: weixin {baseUrl} | qq {mode, onebotHttpUrl, onebotAccessToken, appId, appSecret, ownerId} | feishu {appId, appSecret, verificationToken, domain, ownerId} | dingtalk {clientId, clientSecret, robotCode, defaultWebhook, ownerId}.',
        },
        enabled: { type: 'boolean', description: 'configure: enable (default) / disable the platform.' },
        mode: { type: 'string', enum: ['onebot', 'official'], description: 'configure qq: onebot (NapCat) or official.' },
        whitelist: { type: 'array', items: { type: 'string' }, description: 'configure: only answer these sender / group ids (empty = everyone).' },
        qrcode: { type: 'string', description: 'weixin_qr_poll: the qrcode returned by weixin_qr_start.' },
        timeoutMs: { type: 'number', description: 'weixin_poll: long-poll timeout in ms (max 45000).' },
      },
      run: (args) => manageIm(service, args, imNet()),
    }),
  ];

  /** Register the IM extension card + optional auto-poll loop (both reversible via track). */
  function mountIm({ extensionId }) {
    // The card must mirror the switch the user actually flipped (config.extensions.*),
    // otherwise the panel claims "active" for a feature that is already refusing calls.
    track(() =>
      service.registerExtension({
        id: extensionId,
        name: '💬 跨端分身 (微信 / QQ / 飞书 / 钉钉)',
        description: '同一个人设、心情与记忆，在个人微信 / QQ / 飞书 / 钉钉里陪你聊；每条消息都会点亮 3D 神经星云，密钥永不入记忆。',
        version: '0.1.0',
        enabledWhen: (conf) => conf.extensions?.imEnabled !== false,
      })
    );

    if (cfg.imAutoPoll === true) {
      track(() => startWeixinPollLoop(service, { ...imNet(), onError: (e) => warn('weixin poll failed', e) }));
    }
  }

  return { tools, imNet, mountIm };
}
