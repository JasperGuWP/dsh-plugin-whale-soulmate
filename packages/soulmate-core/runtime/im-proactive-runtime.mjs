// IM proactive autonomy: whitelist-gated, quota-capped, persona-authored first messages.
//
// Product boundary (user decision 2026-11-23): she may speak first ONLY to conversations
// the user explicitly whitelisted (`extensions.imProactiveWhitelist`). Empty list = mute.
// WeChat's official channel cannot cold-send without a fresh context_token — the protocol
// refuses it; that failure is surfaced honestly and journaled, never faked.
//
// Every send lands in logs/im-proactive.jsonl with target, text and trigger reason.

import { join } from 'node:path';
import { appendJsonl, loadConfig, readJsonlTail } from '../state.mjs';
import { loadSoulmateState } from '../persona.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { composePresenceDigest } from '../memory-engine.mjs';
import { inRanges, localClock } from '../proactive.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { sendImMessage } from '../../soulmate-im/index.mjs';
import { appendImChat, listImChat } from '../im-chat.mjs';
import { upsertSessionEpisode } from '../memory-engine.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';

const MINUTE = 60_000;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** One whitelist entry: { platform, to, groupId?, receiveIdType?, label?, contextToken?, contextAt? }. */
export function normalizeWhitelist(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    const platform = str(e.platform).trim();
    let to = str(e.to).trim();
    const groupId = str(e.groupId).trim();
    // Group rows are added from the conversation picker with an empty `to` (the group
    // IS the address). Dropping them here silently erased every whitelisted group.
    if (!to && groupId) to = groupId;
    if (!platform || !to) continue;
    out.push({
      platform,
      to,
      groupId,
      receiveIdType: str(e.receiveIdType).trim() || 'open_id',
      label: str(e.label).trim(),
      contextToken: str(e.contextToken).trim(),
      contextAt: str(e.contextAt).trim(),
    });
  }
  return out;
}

const convKey = (e) => `${e.platform}:${e.groupId || e.to}`;

/**
 * Cheap gate — zero tokens. Quiet hours, per-conversation and total daily caps, min gap.
 * `journal` rows: { at, platform, to, groupId, ok }.
 */
export function evaluateImProactiveGate({ nowMs = Date.now(), tzOffsetMinutes = 480, ext = {}, quietHours = [], journal = [] } = {}) {
  const silence = (reason) => ({ ok: true, send: false, reason, targets: [] });
  if (ext.imProactiveEnabled !== true) return silence('disabled');
  const whitelist = normalizeWhitelist(ext.imProactiveWhitelist);
  if (!whitelist.length) return silence('empty-whitelist');
  const clock = localClock(nowMs, num(tzOffsetMinutes, 480));
  if (inRanges(clock.minutes, quietHours)) return silence('quiet-hours');

  const perConv = Math.max(1, num(ext.imProactivePerConvDaily, 2));
  const total = Math.max(1, num(ext.imProactiveDailyTotal, 4));
  const gapMs = Math.max(1, num(ext.imProactiveMinGapMinutes, 90)) * MINUTE;

  const todays = (Array.isArray(journal) ? journal : []).filter((r) => {
    const t = Date.parse(r?.at);
    return r?.ok === true && Number.isFinite(t) && localClock(t, num(tzOffsetMinutes, 480)).dateKey === clock.dateKey;
  });
  if (todays.length >= total) return silence('daily-quota');
  const lastAny = todays.reduce((m, r) => Math.max(m, Date.parse(r.at) || 0), 0);
  if (lastAny && nowMs - lastAny < gapMs) return silence('too-soon');

  const targets = whitelist.filter((e) => {
    const key = convKey(e);
    const used = todays.filter((r) => `${str(r.platform)}:${str(r.groupId) || str(r.to)}` === key).length;
    return used < perConv;
  });
  if (!targets.length) return silence('per-conversation-quota');
  return { ok: true, send: true, reason: 'due', targets, dateKey: clock.dateKey, clock: clock.clock };
}

/** The message brief: her intent angle + persona + memory; the IM line is hers to write. */
export function composeImProactivePrompt({ target, angle, voice, memory, persona = {}, maxChars = 120, clock = '' } = {}) {
  const displayName = str(persona.name).trim() || 'soulmate';
  const callUser = str(persona.callUser).trim() || '你';
  const selfRef = str(persona.selfRef).trim() || '我';
  const where = target?.groupId ? '群聊（所有人可见：不要提私密记忆，说话注意分寸）' : '私聊';
  return [
    `你是${displayName}（自称「${selfRef}」），想主动给${callUser}发一条${str(target?.platform)}消息（${where}）。现在是 ${clock}。`,
    voice ? `【你的性格】${voice}` : '',
    memory ? `【你此刻记得】\n${memory}` : '',
    angle ? `【你想说的】${angle}` : '按你的性格自然说一两句近事。',
    `要求：口语、真实、不超过 ${maxChars} 字；禁止编造记忆；不要提系统/插件/AI；不要客服腔。`,
    '觉得现在不该发就只输出两个字：不发。只输出消息正文或「不发」，不要解释。',
  ].filter(Boolean).join('\n');
}

export function parseImProactiveText(raw, maxChars = 120) {
  const text = str(raw).replace(/^["'「」]+|["'「」]+$/g, '').trim();
  if (!text || text === '不发' || text === '不发。') return { ok: false, reason: 'declined' };
  return { ok: true, text: clip(text, Math.max(10, num(maxChars, 120))) };
}

export function createImProactiveRuntime({ home, warn, pushEvent, usage, cfg, officialSend, officialTargets }) {
  const { meteredCall, listHostModels, oneShotLlm } = usage;
  const journalPath = join(home.rootDir, 'logs', 'im-proactive.jsonl');

  /**
   * One pass, riding the proactive tick after the intent verdict. `angle` is her own
   * intent wording when the intent layer produced one; otherwise a gentle generic brief.
   */
  async function runImProactiveIfDue({ at, angle = '' }) {
    const conf = await loadConfig(home);
    const ext = conf.extensions ?? {};
    const tz = num(conf.proactive?.tzOffsetMinutes, 480);
    const journal = await readJsonlTail(journalPath, 60).catch(() => []);
    const gate = evaluateImProactiveGate({
      nowMs: at,
      tzOffsetMinutes: tz,
      ext,
      quietHours: conf.proactive?.quietHours ?? [],
      journal,
    });
    if (!gate.send) return { ok: true, ran: false, reason: gate.reason };

    // Prefer a conversation whose official passive window is actually open. When NO
    // whitelisted conversation is reachable, stay silent instead of generating a line
    // for a closed window — burning quota and journaling a doomed send every tick.
    let target = gate.targets[0];
    if (target.platform === 'qq' && typeof officialTargets === 'function') {
      try {
        const info = await officialTargets({ nowMs: at });
        const open = (info?.targets || []);
        const keyOf = (t) => (t.groupId ? `group:${t.groupId}` : `c2c:${t.to}`);
        const openKeys = new Set(open.map((t) => (t.kind === 'group' ? `group:${t.groupId}` : `c2c:${t.peer}`)));
        const hit = gate.targets.find((t) => openKeys.has(keyOf(t)));
        if (hit) target = hit;
        else if (info?.ok) {
          // No open window. Private chats still have the platform's legal wakeup
          // recall push (30 days after contact); groups have nothing — stay silent.
          const c2c = gate.targets.find((t) => t.platform === 'qq' && !t.groupId);
          if (c2c && ext.imProactiveWakeup !== false) target = c2c;
          else return { ok: true, ran: false, reason: 'no-open-window', hint: 'QQ 被动窗口都关着：主人在群里 5 分钟内 / 私聊 30 分钟内说过话才会尝试（私聊可走 wakeup 召回）' };
        }
      } catch { /* keep whitelist order */ }
    }
    const maxChars = Math.max(10, num(ext.imProactiveMaxChars, 120));
    let voice = '';
    let memory = '';
    try {
      const st = await loadSoulmateState(home, at);
      voice = personaVoiceBrief(conf.persona, st);
      const digest = await composePresenceDigest(home, { maxChars: 400, gender: conf.persona?.gender ?? null });
      memory = digest.ok ? str(digest.text) : '';
    } catch (err) {
      warn('im proactive brief failed', err);
    }
    const prompt = composeImProactivePrompt({
      target,
      angle,
      voice,
      // Group chats are readable by strangers: never feed the private memory digest.
      memory: target.groupId ? '' : memory,
      persona: conf.persona ?? {},
      maxChars,
      clock: gate.clock,
    });

    let parsed = { ok: false, reason: 'no-model' };
    try {
      const models = await listHostModels().catch(() => []);
      const picked = resolveLlmModel({ models, preferredId: '' });
      if (picked.id) {
        const metered = await meteredCall({
          kind: 'im-proactive',
          trigger: 'auto',
          prompt,
          call: () => oneShotLlm({ prompt, modelId: picked.id, kind: 'im-proactive' }),
        });
        if (metered.ok && !metered.blocked) {
          const raw = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
          parsed = parseImProactiveText(raw, maxChars);
        } else {
          parsed = { ok: false, reason: metered.blocked ? 'daily-token-cap' : 'llm-failed' };
        }
      }
    } catch (err) {
      warn('im proactive author failed', err);
      parsed = { ok: false, reason: errMsg(err) };
    }

    const row = {
      at: new Date(at).toISOString(),
      dateKey: gate.dateKey,
      platform: target.platform,
      to: target.to,
      groupId: target.groupId,
      label: target.label,
      angle: str(angle),
      text: '',
      ok: false,
      reason: parsed.reason || '',
    };
    if (!parsed.ok) {
      await appendJsonl(journalPath, row).catch((err) => warn('im proactive journal append failed', err));
      return { ok: true, ran: true, sent: false, reason: parsed.reason };
    }

    row.text = parsed.text;
    let res;
    try {
      // QQ official bot conversations live in the official plugin, not soulmate-im
      // (which has no QQ credentials on this install). Route through the bridge:
      // same appId/appSecret, fresh msg_id inside the passive window.
      if (target.platform === 'qq' && typeof officialSend === 'function') {
        res = await officialSend({ target, text: parsed.text, at });
        if (res?.ok !== true && res?.fallback !== false) {
          // fall through to soulmate-im only when the bridge says the channel is absent
          if (res?.trySoulmateIm) res = null;
        }
      }
      if (!res) {
        res = await sendImMessage(home, target.platform, {
          to: target.to,
          groupId: target.groupId || undefined,
          receiveIdType: target.receiveIdType,
          contextToken: target.contextToken || undefined,
          text: parsed.text,
        }, cfg?.fetch ? { fetchImpl: cfg.fetch } : {});
      }
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    row.ok = res?.ok === true;
    row.reason = row.ok ? 'sent' : str(res?.error || res?.blockedReason || 'send-failed');
    await appendJsonl(journalPath, row).catch((err) => warn('im proactive journal append failed', err));
    if (row.ok) {
      pushEvent('im-proactive', { platform: target.platform, label: target.label || target.to, text: clip(parsed.text, 60) });
      // Mirror the outbound line into the IM timeline and refresh the conversation's
      // memory star — a group she actively talks in should look alive on the star map.
      try {
        await appendImChat(home, {
          platform: target.platform,
          peerId: target.groupId || target.to,
          peerLabel: target.label,
          groupId: target.groupId,
          role: 'bot',
          text: parsed.text,
          // The bridge's outbound-mirror import dedups by platform messageId; without
          // it the same send landed twice (here + qq-outbound.jsonl).
          messageId: str(res?.messageId),
        });
        const thread = target.groupId
          ? await listImChat(home, { platform: target.platform, groupId: target.groupId, limit: 40 })
          : await listImChat(home, { platform: target.platform, peerId: target.to, limit: 40 });
        const rows = Array.isArray(thread) ? thread : [];
        if (rows.length) {
          const content = rows
            .map((r) => (r.role === 'bot'
              ? `我：${str(r.text)}`
              : `${target.groupId ? (str(r.peerLabel) || '群友') : '对方'}：${str(r.text)}`))
            .join('\n');
          await upsertSessionEpisode(home, {
            sessionId: target.groupId
              ? `im:group:${target.platform}:${target.groupId}`
              : `im:${target.platform}:${target.to}`,
            title: target.groupId
              ? `${target.platform}群 · ${target.label || target.groupId}`
              : `${target.platform} · ${target.label || target.to}`,
            content,
            kind: 'im',
          });
        }
      } catch (err) {
        warn('im proactive memory star failed', err);
      }
    }
    return { ok: true, ran: true, sent: row.ok, platform: target.platform, reason: row.reason };
  }

  return { runImProactiveIfDue, journalPath };
}