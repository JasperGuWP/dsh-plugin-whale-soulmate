// The dedicated companion chat window: ensure/rotate + handoff distillation,
// wake delivery via sessionController.prompt, the persona quiz opener and the
// once-per-process boot greeting. Session stars live in session-star-runtime.

import { appendJsonl, loadConfig, saveConfigAuto } from '../state.mjs';
import { PRESETS, getDisplayName, loadSoulmateState } from '../persona.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { composePresenceDigest } from '../memory-engine.mjs';
import { createChatHomeWorkspace } from './chat-home-workspace.mjs';

import { companionSpokenText, extractLatestAssistantUsage, isToastWorthyReply, waitForSessionUsage } from '../usage.mjs';
import { priceWindow } from '../proactive.mjs';
import {
  buildPetSay,
  buildWakeInstructions,
  buildWakeVisibleNotice,
  deliverViaPrompt,
  describeLastUserContact,
  ensureChatHomeSession,
  isSessionFull,
  latestRealUserMessageAt,
  measureFromRecords,
  normalizeChatHome,
  stripWakeBubbleMark,
  tryFocusSession,
} from '../chat-home.mjs';
import { registerKnownSession, sessionIdsToWatch } from '../session-star.mjs';
import { errMsg } from '../small-utils.mjs';
import { createSessionStarRuntime } from './session-star-runtime.mjs';

/** Rate card of an instant, so a quiet night is explainable instead of mysterious. */
export const priceInfo = (at) => {
  const window = priceWindow(at);
  return { priceWindow: window, offPeak: window === 'offpeak' };
};

export function createChatHomeRuntime({ home, ctx, sessionController, promptEngine, pushEvent, warn, meteredCall }) {
  const notePetSay = (text, kind = 'proactive', extra = {}) => {
    // Allow `notePetSay(text, kind, { sessionId })` from the reply watch.
    const opts = extra && typeof extra === 'object' ? extra : {};
    return promptEngine.notePetSay(text, kind, pushEvent, opts);
  };

  // Workspace attach + handoff distillation live in their own module.
  const {
    resolveChatHomeCreateRequest,
    attachSessionsToChatHome,
    runHandoffDistill,
  } = createChatHomeWorkspace({ home, ctx, pushEvent, warn });

  /** Persist chatHome patch after ensure/rotate. */
  const saveChatHome = async (chatHome) => {
    await saveConfigAuto(home, { chatHome: normalizeChatHome(chatHome) });
    return normalizeChatHome(chatHome);
  };

  // ---- session stars (auto window episodes) --------------------------------
  // Discovery / fingerprint dedupe / debounced upserts live in their own runtime.
  const { maybeCaptureSessionStars, noteChatHomeSession, scheduleSessionStarCapture } =
    createSessionStarRuntime({ home, ctx, sessionController, warn });

  /** Ensure dedicated companion session; rotate + distill when full. */
  async function ensureHomeSession(options = {}) {
    const conf = await loadConfig(home);
    const controller = sessionController();
    // Keep「{人设名}消息」workspace title in sync even when we are not creating a session.
    try { await resolveChatHomeCreateRequest(); } catch { /* optional */ }
    let result = await ensureChatHomeSession({
      chatHome: conf.chatHome,
      controller,
      persona: conf.persona,
      resolveCreateRequest: resolveChatHomeCreateRequest,
      onHandoff: runHandoffDistill,
      seedAfterRotate: options.seedAfterRotate !== false && conf.chatHome?.handoffSeed !== false,
      forceRotate: options.forceRotate === true,
      // Default true (boot / proactive may rotate). IM drafts pass false.
      rotateIfFull: options.rotateIfFull !== false,
    });
    if (result.ok && result.chatHome) {
      // Persist the persona-synced titlePrefix so panel status matches the sidebar,
      // and fold the active/created session into knownSessionIds for star watch.
      const withKnown = registerKnownSession(result.chatHome, result.sessionId);
      const saved = await saveChatHome(withKnown);
      result = { ...result, chatHome: saved };
      // Re-home active + known dedicated sessions under「{人设名}消息」.
      // Rename-only boot paths used to leave them in「未分组」forever.
      try {
        await attachSessionsToChatHome(sessionIdsToWatch(saved));
      } catch (err) {
        warn('chat-home workspace attach failed', err);
      }
    }
    if (result.rotated) {
      pushEvent('chat-home-rotate', {
        sessionId: result.sessionId,
        reason: result.fullness?.reason || '',
      });
    }
    return result;
  }

  async function startPersonaQuiz() {
    const controller = sessionController();
    if (typeof controller?.prompt !== 'function') {
      return { ok: false, error: 'sessionController.prompt 不可用，请确认 DSH 已就绪' };
    }
    const ensured = await ensureHomeSession({ seedAfterRotate: false });
    if (!ensured.ok || !ensured.sessionId) {
      return { ok: false, error: ensured.error || '无法打开专属会话' };
    }
    const conf = await loadConfig(home);
    const displayName = getDisplayName(conf.persona);
    const callUser = conf.persona?.callUser;
    promptEngine.setWakeInstructions(buildWakeInstructions('persona-quiz', { callUser, displayName }));
    notePetSay(buildPetSay('persona-quiz', { callUser, displayName }), 'persona-quiz');
    // Probe host UI services that may own session switching (not only sessionController).
    // Cordis: never touch ctx.x unless inject declares it — use ctx.get only.
    const focusExtras = {
      sessions: typeof ctx.get === 'function' ? ctx.get('sessions') : undefined,
      router: typeof ctx.get === 'function' ? ctx.get('router') : undefined,
      navigation: typeof ctx.get === 'function' ? ctx.get('navigation') : undefined,
      conversationUi: typeof ctx.get === 'function' ? ctx.get('conversationUi') : undefined,
      ui: typeof ctx.get === 'function' ? ctx.get('ui') : undefined,
      // Browser-only; harmless no-op on node when absent.
      uiWorkspace: typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined,
    };
    let focused = await tryFocusSession(controller, ensured.sessionId, focusExtras);
    const delivered = await deliverViaPrompt(controller, {
      sessionId: ensured.sessionId,
      kind: 'persona-quiz',
      visibleText: buildWakeVisibleNotice('persona-quiz', {
        callUser,
        name: displayName,
        displayName,
      }),
    });
    if (!delivered.ok) {
      promptEngine.setWakeInstructions('');
      return { ok: false, error: delivered.reason || '投递失败', sessionId: ensured.sessionId, displayName, focused };
    }
    // Some hosts only surface the session after a prompt lands — retry focus once.
    if (!focused) {
      focused = await tryFocusSession(controller, ensured.sessionId, focusExtras);
    }
    pushEvent('persona-quiz', { sessionId: ensured.sessionId, displayName, focused });
    return {
      ok: true,
      sessionId: ensured.sessionId,
      displayName,
      focused,
      delivered: true,
    };
  }

  /**
   * Deliver a wake into the dedicated DSH chat window via sessionController.prompt.
   * Falls back to activity-event / silent when the host has no prompt API.
   */
  const hostDeliverer = (plan, deliveryKind = 'proactive') => {
    const controller = sessionController();
    // Only prompt creates identified messages; bare followup corrupts session storage.
    if (typeof controller?.prompt !== 'function') {
      return undefined;
    }
    return async (text) => {
      const intentSteps = Math.max(1, Math.min(6, Math.floor(Number(plan?.steps) || 1)));
      const res = await meteredCall({
        kind: deliveryKind === 'boot' ? 'boot' : 'proactive',
        trigger: 'auto',
        prompt: text,
        call: async () => {
          // Do not enqueue a separate handoff-seed: this wake is the first turn in the
          // (possibly new) window. Memory handoff already ran inside ensure on rotate.
          // Reuse the active dedicated window on boot — only rotate when full / missing /
          // corrupt / persona-change. (Earlier forceRotate-on-boot spilled「大海 · N」.)
          const ensured = await ensureHomeSession({
            seedAfterRotate: false,
            forceRotate: false,
          });
          if (!ensured.ok || !ensured.sessionId) {
            return { ok: false, reason: ensured.error || 'no-chat-home' };
          }
          const conf = await loadConfig(home);
          const callUser = conf.persona?.callUser;
          const name = getDisplayName(conf.persona);
          const selfRef = conf.persona?.selfRef;
          const preset = conf.persona?.preset;
          const voiceHint = Array.isArray(PRESETS[preset]?.catchphrases)
            ? PRESETS[preset].catchphrases.slice(0, 2).join(' / ')
            : '';
          // 性格小传 + 此刻记得：喂进 wake 指令，让开口有据可依，而不是自由发挥成助手腔。
          let voice = '';
          let memory = '';
          if (deliveryKind === 'boot' || deliveryKind === 'proactive' || deliveryKind.startsWith('intent-')) {
            try {
              const st = await loadSoulmateState(home);
              voice = personaVoiceBrief(conf.persona, st);
              const digest = await composePresenceDigest(home, {
                maxChars: 500,
                gender: conf.persona?.gender ?? PRESETS[preset]?.gender ?? null,
              });
              memory = digest.ok ? String(digest.text || '') : '';
            } catch (err) {
              warn('wake persona/memory brief failed', err);
            }
          }
          // Snapshot before prompt so we only bill the new assistant turn's provider usage,
          // and read when HE last really spoke — never infer it from the previous wake.
          const tz = Number(conf.proactive?.tzOffsetMinutes) || 480;
          let beforeMessageId = '';
          let beforeAssistantCount = 0;
          let lastUserAt = 0;
          if (typeof controller.events === 'function') {
            try {
              const page = await controller.events({
                address: { kind: 'session', sessionId: ensured.sessionId },
                // Wider than the usage baseline needs: the real "he last spoke" line may be
                // many turns back after a night of wakes.
                maxMessages: 120,
              }, new AbortController().signal);
              const snap = extractLatestAssistantUsage(page);
              beforeMessageId = snap.messageId || '';
              beforeAssistantCount = snap.assistantCount || 0;
              lastUserAt = latestRealUserMessageAt(page);
            } catch {
              // Baseline is best-effort; missing it only risks attributing an older turn.
            }
          }
          const absenceText = describeLastUserContact(lastUserAt, Date.now(), tz);
          const instructions = buildWakeInstructions(deliveryKind, {
            callUser,
            hint: text,
            selfRef,
            preset,
            voiceHint,
            voice,
            memory,
            absenceText,
            steps: intentSteps,
          });
          const visible = buildWakeVisibleNotice(deliveryKind, { callUser, hint: text, name, absenceText });
          const petLine = buildPetSay(deliveryKind, {
            callUser,
            hint: text,
            persona: conf.persona,
            preset,
            selfRef,
            traits: conf.persona?.traits,
          });
          // Instructions ride systemPrompt.context once; the chat bubble only gets a short notice.
          promptEngine.setWakeInstructions(instructions);
          // Preview only — OS toast waits for the专属窗 final reply (see notePetSay below).
          notePetSay(petLine, deliveryKind, { preview: true });

          const delivered = await deliverViaPrompt(controller, {
            sessionId: ensured.sessionId,
            kind: deliveryKind,
            visibleText: visible,
          });
          if (!delivered.ok) {
            promptEngine.setWakeInstructions('');
            return { ok: false, reason: delivered.reason || 'prompt-failed' };
          }

          // prompt() returns {accepted:true} before the model finishes — wait for real usage.
          let replyText = visible;
          let usagePayload = null;
          let toastedFinal = false;
          const wakePlain = stripWakeBubbleMark(visible);
          try {
            const waited = await waitForSessionUsage(controller, {
              sessionId: ensured.sessionId,
              beforeMessageId,
              beforeAssistantCount,
              timeoutMs: 60_000,
              // Never toast the wake user-bubble / meta prompts — only her spoken reply.
              rejectTexts: [wakePlain, petLine, visible],
            });
            if (waited?.ok) {
              if (waited.messageId || waited.assistantCount) {
                promptEngine.markAssistantSettled?.(waited.messageId, waited.assistantCount);
              }
              if (waited.text && isToastWorthyReply(waited.text, { rejectTexts: [wakePlain, petLine, visible] })) {
                replyText = waited.text;
                // Final专属窗 line → activity feed → Windows toast body.
                notePetSay(replyText, deliveryKind);
                toastedFinal = true;
              }
              if (waited.rawUsage) usagePayload = waited.rawUsage;
              else if (waited.usage?.real) {
                usagePayload = {
                  inputTokens: waited.usage.promptTokens,
                  outputTokens: waited.usage.completionTokens,
                  totalTokens: waited.usage.totalTokens,
                };
              }
              // Fast path: turn really finished → debounce session-star upsert when watched.
              try {
                const ch = normalizeChatHome(conf.chatHome);
                if (ch.autoMemory !== false && sessionIdsToWatch(ch).includes(ensured.sessionId)) {
                  scheduleSessionStarCapture(ensured.sessionId);
                }
              } catch (starErr) {
                warn('session star fast-path schedule failed', starErr);
              }
            }
          } catch (err) {
            warn('session usage wait failed', err);
          }
          if (!toastedFinal) notePetSay(petLine, deliveryKind);

          return {
            ok: true,
            text: replyText,
            sessionId: ensured.sessionId,
            via: 'host',
            usage: usagePayload || undefined,
            out: delivered.out,
          };
        },
      });
      // meteredCall always wraps as `{ ok: true, out }`; surface inner refusal so
      // deliverNudge can fall back to the activity bubble instead of claiming host delivery.
      if (res?.blocked) return res;
      if (res?.out && res.out.ok === false) return { ok: false, reason: res.out.reason || 'deliver-failed', usage: res.usage };
      return res;
    };
  };

  /** Process-local: one successful boot greeting per DSH process. */
  let bootGreetingDone = false;

  async function runBootGreeting(options = {}) {
    const conf = await loadConfig(home);
    const chatHome = normalizeChatHome(conf.chatHome);
    if (chatHome.bootGreeting === false && options.force !== true) {
      return { ok: true, ran: false, reason: 'disabled' };
    }
    // Before onboarding the persona is still the neutral factory default; greeting now
    // would leak a voice the user never chose. The onboard route fires the greeting
    // itself once the real preset lands.
    if (conf.onboardingCompleted !== true && options.force !== true) {
      return { ok: true, ran: false, reason: 'onboarding-pending' };
    }
    if (bootGreetingDone && options.force !== true) {
      return { ok: true, ran: false, reason: 'already-this-process' };
    }

    const deliver = hostDeliverer({ kind: 'boot', speak: true, text: '' }, 'boot');
    if (typeof deliver !== 'function') {
      // Do not burn the once-per-process flag: sessionController may appear a moment later.
      pushEvent('boot-greeting', { via: 'silent', reason: 'no-prompt-api' });
      await appendJsonl(home.proactiveLogPath, {
        at: new Date().toISOString(),
        kind: 'boot',
        speak: true,
        reason: 'no-prompt-api',
        delivered: 'silent',
      }).catch(() => {});
      return { ok: true, ran: false, reason: 'no-prompt-api' };
    }

    const res = await deliver('');
    const blocked = res?.blocked === true;
    const failed = blocked || res?.ok === false;
    const via = failed ? 'silent' : 'host';
    const reason = blocked
      ? (res.reason || 'daily-token-cap')
      : (failed ? (res?.reason || 'boot-failed') : 'boot');
    const sessionId = res?.out?.sessionId || res?.sessionId || '';
    pushEvent('boot-greeting', { via, blocked, reason, sessionId });
    await appendJsonl(home.proactiveLogPath, {
      at: new Date().toISOString(),
      kind: 'boot',
      speak: true,
      reason,
      delivered: via,
      sessionId,
    }).catch(() => {});

    // Only lock the flag after a real host delivery — failed boots may be retried.
    if (!failed) bootGreetingDone = true;
    return { ok: true, ran: !failed, via, blocked, reason, result: res };
  }

  /** Boot with retries: sessionController / model often need a few seconds after process start. */
  async function runBootGreetingWithRetry(options = {}) {
    const delays = Array.isArray(options.delaysMs) ? options.delaysMs : [0, 3000, 8000];
    let last = { ok: true, ran: false, reason: 'not-attempted' };
    for (let i = 0; i < delays.length; i += 1) {
      if (bootGreetingDone && options.force !== true) {
        return { ok: true, ran: false, reason: 'already-this-process', attempts: i };
      }
      const wait = Number(delays[i]) || 0;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = await runBootGreeting({ force: options.force === true });
      if (last.ran) return { ...last, attempts: i + 1 };
      // Cap block is permanent for the day — do not spin.
      if (last.blocked || last.reason === 'disabled') return { ...last, attempts: i + 1 };
    }
    return { ...last, attempts: delays.length };
  }

  async function chatHomeStatus(options = {}) {
    const conf = await loadConfig(home);
    const chatHome = normalizeChatHome(conf.chatHome);
    const controller = sessionController();
    let measure = null;
    let fullness = null;
    if (chatHome.activeSessionId && typeof controller?.events === 'function') {
      try {
        const page = await controller.events({
          address: { kind: 'session', sessionId: chatHome.activeSessionId },
          maxMessages: Math.min(200, Math.max(chatHome.maxTurns + 10, 40)),
        }, new AbortController().signal);
        measure = measureFromRecords(page);
        fullness = isSessionFull(measure, chatHome);
      } catch (err) {
        measure = { ok: false, error: errMsg(err) };
      }
    }
    return {
      ok: true,
      chatHome,
      measure,
      fullness,
      bootGreetingDone,
      hasPromptApi: typeof controller?.prompt === 'function',
      hasCreateApi: typeof controller?.create === 'function',
      ...priceInfo(Number(options.nowMs) || Date.now()),
    };
  }

  /**
   * Watch ALL DSH conversations (every workspace session, not only 专属窗).
   * Sources: sessionController.list (running + recently updated) + persona touch ids.
   * Also kick on agent/status leaving "running" so toasts land as soon as a turn ends.
   */
  let replyWatchTimer = 0;
  let replyWatchStopped = false;
  /** @type {Set<string>} */
  const pendingIdleCheck = new Set();

  async function collectWatchSessionIds(controller) {
    const ids = [];
    const seen = new Set();
    const pushId = (id) => {
      const sid = String(id || '').trim();
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      ids.push(sid);
    };
    for (const id of pendingIdleCheck) pushId(id);
    pendingIdleCheck.clear();
    for (const id of (promptEngine.getRecentSessionIds?.() || [])) pushId(id);
    pushId(promptEngine.sessionId);
    try {
      const conf = await loadConfig(home);
      pushId(conf.chatHome?.activeSessionId);
    } catch { /* ignore */ }

    if (typeof controller?.list === 'function') {
      try {
        const listed = await controller.list({}, new AbortController().signal);
        const items = Array.isArray(listed?.items) ? listed.items : (Array.isArray(listed) ? listed : []);
        const ranked = items
          .map((it) => ({
            id: String(it?.sessionId || it?.id || ''),
            running: it?.running === true,
            updatedAt: Number(it?.updatedAt) || 0,
            blank: it?.blank === true,
          }))
          .filter((it) => it.id && !it.blank)
          .sort((a, b) => {
            if (a.running !== b.running) return a.running ? -1 : 1;
            return b.updatedAt - a.updatedAt;
          });
        for (const it of ranked.slice(0, 16)) pushId(it.id);
      } catch (err) {
        warn?.('session list for toast watch failed', err);
      }
    }
    return ids;
  }

  async function checkSessionForToast(controller, sid) {
    const page = await controller.events({
      address: { kind: 'session', sessionId: sid },
      maxMessages: 40,
    }, new AbortController().signal);
    const hit = extractLatestAssistantUsage(page);
    const mid = String(hit.messageId || '').trim();
    if (!mid) return;
    const cur = promptEngine.getSessionCursor?.(sid) || { messageId: '', assistantCount: 0 };
    if (!cur.messageId) {
      promptEngine.setSessionCursor?.(sid, mid, hit.assistantCount);
      return;
    }
    if (mid === cur.messageId) return;
    promptEngine.setSessionCursor?.(sid, mid, hit.assistantCount);
    const spoken = companionSpokenText(hit.text);
    if (spoken && isToastWorthyReply(spoken, { allowAnyLanguage: true })) {
      promptEngine.setSessionId?.(sid);
      notePetSay(spoken, 'chat', { sessionId: sid });
    }
  }

  async function replyWatchTick() {
    if (replyWatchStopped) return;
    try {
      const controller = sessionController();
      if (typeof controller?.events === 'function') {
        const ids = await collectWatchSessionIds(controller);
        for (const sid of ids) {
          try {
            await checkSessionForToast(controller, sid);
          } catch (err) {
            warn?.('reply watch session failed', sid, err);
          }
        }
      }
    } catch (err) {
      warn?.('global reply toast watch failed', err);
    }
    if (!replyWatchStopped) {
      replyWatchTimer = setTimeout(replyWatchTick, 1000);
      if (typeof replyWatchTimer.unref === 'function') replyWatchTimer.unref();
    }
  }

  function startReplyToastWatch() {
    replyWatchStopped = false;
    if (replyWatchTimer) clearTimeout(replyWatchTimer);
    replyWatchTimer = setTimeout(replyWatchTick, 500);
    if (typeof replyWatchTimer.unref === 'function') replyWatchTimer.unref();

    const disposers = [];
    // Fire as soon as any agent leaves "running" — covers every DSH chat turn.
    if (typeof ctx?.on === 'function') {
      try {
        const offStatus = ctx.on('agent/status', (payload) => {
          try {
            const agent = payload?.agent ?? payload;
            const status = String(payload?.status ?? agent?.status ?? '');
            const sid = String(agent?.id || agent?.sessionId || payload?.sessionId || '').trim();
            if (!sid) return;
            if (status === 'running') {
              promptEngine.setSessionId?.(sid);
              return;
            }
            // idle / ready / error after a turn → check that session next tick
            pendingIdleCheck.add(sid);
            promptEngine.setSessionId?.(sid);
            if (!replyWatchStopped) {
              clearTimeout(replyWatchTimer);
              replyWatchTimer = setTimeout(replyWatchTick, 200);
              if (typeof replyWatchTimer.unref === 'function') replyWatchTimer.unref();
            }
          } catch { /* ignore */ }
        });
        if (typeof offStatus === 'function') disposers.push(offStatus);
      } catch { /* host may not expose agent/status */ }
    }

    return () => {
      replyWatchStopped = true;
      clearTimeout(replyWatchTimer);
      replyWatchTimer = 0;
      for (const d of disposers) {
        try { d(); } catch { /* ignore */ }
      }
    };
  }

  return {
    ensureHomeSession,
    startPersonaQuiz,
    hostDeliverer,
    runBootGreeting,
    runBootGreetingWithRetry,
    chatHomeStatus,
    maybeCaptureSessionStars,
    noteChatHomeSession,
    scheduleSessionStarCapture,
    notePetSay,
    startReplyToastWatch,
    /** Live host sessionController (for surf-keyword learning across all windows). */
    getSessionController: () => sessionController(),
    /** Test hook: allow a second boot greeting in-process. */
    resetBootGreetingFlag() { bootGreetingDone = false; },
  };
}
