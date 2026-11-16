// Model tools + wiring for the four built-in IM channels (WeChat / QQ / Feishu / DingTalk).
// IM replies are user-initiated, so they are *recorded* but never refused by the cap:
// the person on the other end is waiting. The wrapper exists purely for accounting.

import { IM_MANAGE_ACTIONS, IM_PLATFORMS, manageIm, sendImMessage, startWeixinPollLoop } from '../../soulmate-im/index.mjs';
import { deliverViaPrompt } from '../chat-home.mjs';
import { composeImPersonaPrompt, extractImReplyText } from '../im-reply.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { str } from '../small-utils.mjs';
import { extractLatestAssistantUsage, waitForSessionUsage } from '../usage.mjs';

export function imTools({
  makeTool, service, home, cfg, ctx, pushEvent, warn, track, meteredCall,
  oneShotLlm, listHostModels, chatHome, promptEngine,
}) {
  const meteredImGenerator = (inner) => async (payload) => {
    const res = await meteredCall({
      kind: 'im',
      trigger: 'user',
      prompt: str(payload?.text ?? payload?.content ?? ''),
      call: () => inner(payload),
    });
    return res.ok ? res.out : undefined;
  };

  /**
   * In-character IM reply. Host desktop often has `prompt` but empty model catalog /
   * no `generateReply` — that used to fall straight to the template ("你，我在认真听").
   * Order: generateReply (optional model) → home-session prompt+wait → oneShotLlm.
   */
  async function builtInPersonaReply(payload) {
    const prompt = composeImPersonaPrompt(payload);
    const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController;

    // A) Fast path: host generateReply (model id optional)
    if (typeof controller?.generateReply === 'function') {
      try {
        if (typeof controller.initializeDefaultModel === 'function') {
          try { await controller.initializeDefaultModel(); } catch { /* best-effort */ }
        }
        let modelId = str(cfg.imLlmModel);
        if (!modelId && typeof listHostModels === 'function') {
          try {
            const models = await listHostModels();
            modelId = resolveLlmModel({ models, preferredId: '' }).id || '';
          } catch { /* ignore */ }
        }
        const args = { text: prompt, purpose: 'im' };
        if (modelId) args.model = modelId;
        const out = await controller.generateReply(args);
        const text = extractImReplyText(out);
        if (text) return { text, usage: out?.usage || out?.tokenUsage || null, via: 'generateReply' };
        warn('im persona: generateReply returned empty text');
      } catch (err) {
        warn('im persona: generateReply failed', err);
      }
    }

    // B) Proven path on this host: dedicated window prompt + wait (same as boot)
    if (chatHome && typeof chatHome.ensureHomeSession === 'function' && typeof controller?.prompt === 'function') {
      try {
        // Never rotate for IM drafts — WeChat traffic used to burn maxTurns and spill「大海 · N」.
        const ensured = await chatHome.ensureHomeSession({
          seedAfterRotate: false,
          forceRotate: false,
          rotateIfFull: false,
        });
        if (!ensured?.ok || !ensured.sessionId) {
          warn('im persona: no chat-home session', ensured?.error || 'missing');
        } else {
          const sessionId = ensured.sessionId;
          const userLine = str(payload?.text).trim() || '（空消息）';
          const visible = `【微信】${userLine}`;
          const instructions = [
            prompt,
            '场景：微信私聊回复草稿。',
            '硬性禁止：调用任何工具（尤其 soulmate_im_send / 微信发送类工具）；不要真的去发微信。',
            '只输出一段给对方看的口语正文（一两句，不要空行、不要分点、不要旁白如「微信回过了」）。',
          ].join('\n');
          if (promptEngine && typeof promptEngine.setWakeInstructions === 'function') {
            promptEngine.setWakeInstructions(instructions);
          }

          let beforeMessageId = '';
          let beforeAssistantCount = 0;
          if (typeof controller.events === 'function') {
            try {
              const page = await controller.events({
                address: { kind: 'session', sessionId },
                maxMessages: 40,
              }, typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(12_000)
                : new AbortController().signal);
              const snap = extractLatestAssistantUsage(page);
              beforeMessageId = snap.messageId || '';
              beforeAssistantCount = snap.assistantCount || 0;
            } catch { /* baseline best-effort */ }
          }

          const delivered = await deliverViaPrompt(controller, {
            sessionId,
            kind: 'im',
            visibleText: visible,
          });
          if (!delivered.ok) {
            if (promptEngine?.setWakeInstructions) promptEngine.setWakeInstructions('');
            warn('im persona: prompt deliver failed', delivered.reason || 'prompt-failed');
          } else {
            const waited = await waitForSessionUsage(controller, {
              sessionId,
              beforeMessageId,
              beforeAssistantCount,
              timeoutMs: 55_000,
              rejectTexts: [visible, userLine, instructions.slice(0, 80)],
            });
            if (promptEngine?.setWakeInstructions) promptEngine.setWakeInstructions('');
            const text = str(waited?.text).trim();
            if (waited?.ok && text) {
              return {
                text,
                usage: waited.rawUsage || (waited.usage?.real ? {
                  inputTokens: waited.usage.promptTokens,
                  outputTokens: waited.usage.completionTokens,
                  totalTokens: waited.usage.totalTokens,
                } : null),
                via: 'home-session',
              };
            }
            warn('im persona: home-session wait empty', waited?.reason || waited?.rejectedText || 'empty');
          }
        }
      } catch (err) {
        if (promptEngine?.setWakeInstructions) promptEngine.setWakeInstructions('');
        warn('im persona: home-session path failed', err);
      }
    }

    // C) Last resort one-shot with catalog model
    if (typeof oneShotLlm === 'function' && typeof listHostModels === 'function') {
      try {
        const models = await listHostModels();
        const picked = resolveLlmModel({ models, preferredId: str(cfg.imLlmModel) });
        if (picked?.id) {
          const out = await oneShotLlm({ prompt, modelId: picked.id, kind: 'im' });
          const text = extractImReplyText(out);
          if (text) return { text, usage: out?.usage || null, via: 'oneShot' };
        } else {
          warn('im persona: no host models for oneShot');
        }
      } catch (err) {
        warn('im persona: oneShot failed', err);
      }
    }

    return undefined;
  }

  const imNet = () => ({
    ...(cfg.imFetch ? { fetchImpl: cfg.imFetch } : {}),
    replyGenerator: meteredImGenerator(cfg.imReplyGenerator || builtInPersonaReply),
    ...(cfg.imMemoryVisibility ? { memoryVisibility: cfg.imMemoryVisibility } : {}),
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
        'weixin_qr_start / weixin_qr_poll = official WeChat iLink QR login; weixin_logout = clear WeChat credentials; ' +
        'weixin_poll = pull new WeChat messages once and answer them; stream_ticket = open a DingTalk Stream gateway ticket.',
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
