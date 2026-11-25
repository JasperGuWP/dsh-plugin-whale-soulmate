// The proactive executor: one scheduler tick decides → delivers → maybe dreams →
// maybe runs the weekly gate. The gate logic itself stays pure in proactive.mjs;
// this module owns the I/O (ledger, wiki writes, LLM calls, config bookkeeping).

import { readFile } from 'node:fs/promises';
import { appendJsonl, loadConfig, readJsonlTail, saveConfigAuto } from '../state.mjs';
import { getDisplayName, getNotebookTitles, loadSoulmateState } from '../persona.mjs';
import { listSessionEpisodes, listTrustItems, recordEpisode as recordEpisodeImpl, reflectToWiki } from '../memory-engine.mjs';
import { getEngineSnapshot } from '../layers/index.mjs';
import { estimateTokens } from '../budget.mjs';
import {
  composeDailyDiaryLetters,
  composeDreamDigest,
  composeDreamLlmPrompt,
  deliverNudge,
  diaryMaterialForDate,
  evaluateOpeningGate,
  localClock,
  parseDreamLlmReply,
  pendingDiaryDateKeys,
  postDreamTargets,
  promisePatrolTargets,
  shouldDream,
} from '../proactive.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { createBiliLlmAdapters } from './bili-llm-adapter.mjs';
import { createSurfRuntime } from './surf-runtime.mjs';
import { refreshSurfKeywords } from '../../soulmate-bili/keyword-learn.mjs';
import { runAutoReplyPatrol } from '../../soulmate-bili/reply-patrol.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';
import { priceInfo } from './chat-home-runtime.mjs';
import { createProactiveDistill } from './proactive-distill.mjs';
import { createIntentRuntime } from './intent-runtime.mjs';
import { createGrowthRuntime } from './growth-runtime.mjs';
import { createImProactiveRuntime } from './im-proactive-runtime.mjs';
import { createQqbotBridgeRuntime } from './qqbot-bridge-runtime.mjs';
import { createOfficialQqSender } from './qq-official-send.mjs';
import { createOfficialQqOps } from './qq-official-ops.mjs';
import { createOfficialQqStream } from './qq-official-stream.mjs';
import { runQqVisionIfEnabled } from './qq-vision-runtime.mjs';
import { createExperienceRuntime } from './experience-runtime.mjs';

export function createProactiveRuntime({
  home,
  warn,
  pushEvent,
  promptEngine,
  usage,
  chatHome,
  cfg,
  getService,
}) {
  const { meteredCall, listHostModels, oneShotLlm, kindBudget } = usage;
  const { hostDeliverer, maybeCaptureSessionStars, chatHomeStatus, notePetSay } = chatHome;

  // Distillation pass + budget auto-off live in their own module.
  const { runDistillationCheck, maybeAutoOffLlm } = createProactiveDistill({ home, warn, pushEvent, usage, loadFactsForDream });
  // Intent layer: when on, the schedule gate becomes an opportunity source and *she* decides.
  const experience = createExperienceRuntime({ home, warn, pushEvent, usage });
  const intent = createIntentRuntime({ home, warn, pushEvent, usage, chatHome, experienceBlock: experience.experienceBlock });
  // Weekly gate + growth snapshot live in their own module (600-line assembly ceiling).
  const growth = createGrowthRuntime({ home, warn });
  const biliLlm = createBiliLlmAdapters({ home, usage });
  const surf = createSurfRuntime({ home, warn, pushEvent, usage, chatHome, cfg, getService });
  // Official QQ bot sessions → IM timeline + memory stars (the two worlds were split).
  const qqbotBridge = createQqbotBridgeRuntime({ home, warn, pushEvent });
  // Rich ops (media / recall / typing / wakeup / buttons) share the bridge's credentials.
  const qqOps = createOfficialQqOps({ bridge: qqbotBridge, cfg, warn, home });
  const qqStream = createOfficialQqStream({ bridge: qqbotBridge, cfg, warn, home });
  qqOps.streamText = qqStream.streamText;
  qqOps.openStream = qqStream.openStream;
  const imProactive = createImProactiveRuntime({
    home, warn, pushEvent, usage, cfg,
    officialSend: createOfficialQqSender({ bridge: qqbotBridge, cfg, warn, home, ops: qqOps }),
    officialTargets: (opts) => qqbotBridge.officialSendTargets(opts),
  });

  // Bookkeeping (`proactive.jsonl`) is the dedupe ledger: restarts must not re-greet, and a
  // silent gate must be explainable after the fact.
  const proactiveRecent = async (limit = 40) => {
    const rows = await readJsonlTail(home.proactiveLogPath, limit);
    return rows.map((row) => ({
      kind: typeof row.kind === 'string' ? row.kind : '',
      at: typeof row.at === 'string' ? row.at : '',
      speak: row.speak === true,
      delivered: row.delivered ?? null,
      reason: typeof row.reason === 'string' ? row.reason : '',
    }));
  };

  // The audit log is what a human reads to answer "why did she stay quiet?". Writing the
  // clock in UTC made local 12:10 look like 04:10, which reads like a night dream that
  // never happened. Use the same offset the gate itself used.
  const logClock = async (atIso) => {
    const conf = await loadConfig(home).catch(() => null);
    const tz = Number(conf?.proactive?.tzOffsetMinutes);
    const offset = Number.isFinite(tz) ? tz : 480;
    return localClock(Date.parse(atIso), offset).clock;
  };

  const noteProactive = async (plan, delivered) => {
    const at = plan?.at ?? new Date().toISOString();
    return appendJsonl(home.proactiveLogPath, {
      at,
      dateKey: plan?.dateKey ?? '',
      kind: plan?.kind ?? '',
      speak: plan?.speak === true,
      reason: plan?.reason ?? '',
      delivered: delivered ?? null,
      clock: await logClock(at),
    }).catch((err) => warn('proactive ledger append failed', err));
  };

  /** After day rollover: remind once if a feature stayed off due to yesterday's budget. */
  async function maybePetRemindLlmBudget({ conf, tz, at }) {
    const { dateKey } = localClock(at, tz);
    const p = conf.proactive || {};
    const hints = [];
    if (
      p.dreamLlmEnabled === false &&
      p.dreamLlmAutoOffReason === 'budget-exhausted' &&
      p.dreamLlmPetRemindDateKey !== dateKey
    ) {
      hints.push('做梦');
      await saveConfigAuto(home, { proactive: { dreamLlmPetRemindDateKey: dateKey } });
    }
    if (
      p.distillLlmEnabled === false &&
      p.distillLlmAutoOffReason === 'budget-exhausted' &&
      p.distillLlmPetRemindDateKey !== dateKey
    ) {
      hints.push('蒸馏');
      await saveConfigAuto(home, { proactive: { distillLlmPetRemindDateKey: dateKey } });
    }
    if (!hints.length) return;
    const label = hints.join(' / ');
    notePetSay(`新一天的 LLM ${label}额度已恢复，可在设置里重新打开。`, 'llm-budget');
  }

  /** Public facts only — a dream page lives in `wiki/`, which the sync packer reads. */
  async function loadFactsForDream() {
    const raw = await readFile(home.factsPath, 'utf8').catch((err) => {
      if (err?.code === 'ENOENT') return '';
      throw err;
    });
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // skip a torn line rather than losing the whole scan
      }
    }
    return out;
  }

  async function runDreamIfDue({ conf, cfg: pCfg, tz, at, persona }) {
    await maybePetRemindLlmBudget({ conf, tz, at }).catch((err) => warn('llm budget pet remind failed', err));
    const lastDreamAt = conf.proactive?.lastDreamAt ?? '';
    let facts = [];
    try {
      facts = await loadFactsForDream();
    } catch (err) {
      warn('dream: fact scan failed', err);
    }
    const targets = postDreamTargets({
      facts,
      sinceIso: conf.proactive?.dreamCursor ?? '',
      minSalience: pCfg.dreamMinSalience ?? 0.2,
    });
    // Session window stars updated since the last dream become digest raw material.
    // Body bullets only — not sourceFactIds (Task 4; tick/deliver capture is Task 5).
    const dreamCursorMs = (() => {
      const t = Date.parse(conf.proactive?.dreamCursor || 0);
      return Number.isFinite(t) ? t : 0;
    })();
    let sessionStars = [];
    try {
      sessionStars = (await listSessionEpisodes(home, { includePrivate: false }))
        .filter((e) => {
          const u = Date.parse(e.updatedAt);
          return Number.isFinite(u) && u > dreamCursorMs;
        })
        .map((e) => ({ title: e.title || e.sessionId, summary: clip(e.body, 200) }));
    } catch (err) {
      warn('dream: session star scan failed', err);
    }
    const decision = shouldDream({
      nowMs: at,
      tzOffsetMinutes: tz,
      config: pCfg,
      lastDreamAt,
      targetCount: targets.length + sessionStars.length,
    });
    if (!decision.dream) {
      return {
        ok: true,
        dream: false,
        reason: decision.reason,
        candidates: targets.length + sessionStars.length,
      };
    }
    // Star-sea process: the night's work is visible while it happens.
    pushEvent('memory-progress', { stage: 'dream', work: 'dream', count: targets.length + sessionStars.length });

    let digest = null;
    let via = 'template';
    const llmOn = pCfg.dreamLlmEnabled === true;
    if (llmOn) {
      const cap = Number(pCfg.dreamLlmDailyCap) || 0;
      const budget = await kindBudget('dream-llm', cap, at);
      const models = await listHostModels();
      const picked = resolveLlmModel({ models, preferredId: pCfg.dreamLlmModel || '' });
      const draft = composeDreamLlmPrompt({
        facts: targets,
        sessionStars,
        persona,
        dateKey: decision.dateKey,
      });
      const need = estimateTokens(draft.prompt) + 800;
      if (budget.allow && budget.remaining >= need && picked.id) {
        try {
          const metered = await meteredCall({
            kind: 'dream-llm',
            trigger: 'auto',
            prompt: draft.prompt,
            call: () => oneShotLlm({ prompt: draft.prompt, modelId: picked.id, kind: 'dream-llm' }),
          });
          if (metered.ok && !metered.blocked) {
            const text = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
            const parsed = parseDreamLlmReply(text, {
              dateKey: decision.dateKey,
              displayName: getDisplayName(persona),
              sourceFactIds: draft.sourceFactIds,
            });
            if (parsed?.content) {
              digest = parsed;
              via = 'llm';
              const spent = Number(metered.usage?.totalTokens) || estimateTokens(draft.prompt) + estimateTokens(text);
              await maybeAutoOffLlm('dream', Math.max(0, budget.remaining - spent), at);
            }
          } else if (metered.blocked) {
            await maybeAutoOffLlm('dream', 0, at);
          }
        } catch (err) {
          warn('dream llm failed; falling back to template', err);
        }
      } else if (!budget.allow) {
        await maybeAutoOffLlm('dream', 0, at);
      }
    }

    if (!digest) {
      if (pCfg.dreamReflect === false) {
        return {
          ok: true,
          dream: false,
          reason: llmOn ? 'llm-failed-no-template' : 'dream-reflect-disabled',
          candidates: targets.length + sessionStars.length,
        };
      }
      digest = composeDreamDigest({
        facts: targets,
        sessionStars,
        persona,
        dateKey: decision.dateKey,
      });
      via = 'template';
    }

    const res = await reflectToWiki(home, {
      ...digest,
      category: 'dream',
      sourceFactIds: digest.sourceFactIds,
      nowMs: at,
    });
    if (!res.ok) return { ok: false, dream: false, error: res.error ?? res.blockedReason };
    await saveConfigAuto(home, {
      proactive: { lastDreamAt: new Date(at).toISOString(), dreamCursor: new Date(at).toISOString() },
    });
    await appendJsonl(home.proactiveLogPath, {
      at: new Date(at).toISOString(),
      dateKey: decision.dateKey,
      kind: via === 'llm' ? 'dream-llm' : 'dream',
      speak: false,
      reason: decision.reason || 'night-dream',
      delivered: 'wiki',
      slug: digest.slug,
      facts: targets.length,
      via,
    }).catch((err) => warn('dream ledger append failed', err));
    pushEvent('dream', { ids: [`wiki:${digest.slug}`], count: targets.length, via });
    pushEvent('memory-progress', { stage: 'done', work: 'dream', slug: digest.slug, ids: [`wiki:${digest.slug}`] });
    return { ok: true, dream: true, slug: digest.slug, facts: targets.length, decision: decision.reason, via };
  }

  async function runDailyDiaryIfDue({ conf, cfg: pCfg, tz, at, persona }) {
    const pending = pendingDiaryDateKeys({
      nowMs: at,
      tzOffsetMinutes: tz,
      config: pCfg,
      lastDiaryDateKey: conf.proactive?.lastDiaryDateKey ?? '',
    });
    if (!pending.dates.length) {
      return { ok: true, wrote: false, reason: pending.reason, dates: [] };
    }
    let facts = [];
    try {
      facts = await loadFactsForDream();
    } catch (err) {
      warn('daily diary: fact scan failed', err);
    }
    let sessionStars = [];
    try {
      sessionStars = (await listSessionEpisodes(home, { includePrivate: false }))
        .map((e) => ({
          title: e.title || e.sessionId,
          summary: clip(e.body, 200),
          updatedAt: e.updatedAt,
          date: e.date,
        }));
    } catch (err) {
      warn('daily diary: session star scan failed', err);
    }
    const written = [];
    if (pending.dates.length) pushEvent('memory-progress', { stage: 'diary', work: 'diary', count: pending.dates.length });
    let lastKey = str(conf.proactive?.lastDiaryDateKey);
    for (const dateKey of pending.dates) {
      const material = diaryMaterialForDate({
        facts,
        sessionStars,
        dateKey,
        tzOffsetMinutes: tz,
      });
      const letters = composeDailyDiaryLetters({
        dateKey,
        persona,
        bullets: material.bullets,
      });
      const publicTitle = getNotebookTitles(persona).publicTitle;
      const innerTitle = getNotebookTitles(persona).innerTitle;
      const toYou = await recordEpisodeImpl(home, {
        ...letters.toYou,
        notebookTitle: publicTitle,
        factIds: material.factIds,
        nowMs: at,
      }).catch((err) => ({ ok: false, error: errMsg(err) }));
      const inner = await recordEpisodeImpl(home, {
        ...letters.inner,
        notebookTitle: innerTitle,
        nowMs: at,
      }).catch((err) => ({ ok: false, error: errMsg(err) }));
      if (toYou?.ok) {
        written.push(dateKey);
        lastKey = dateKey;
        pushEvent('daily-diary', { dateKey, toYou: true, inner: !!inner?.ok, quiet: material.bullets.length === 0 });
        await appendJsonl(home.proactiveLogPath, {
          at: new Date(at).toISOString(),
          dateKey,
          kind: 'daily-diary',
          speak: false,
          reason: pending.reason,
          delivered: 'episode',
          bullets: material.bullets.length,
        }).catch((err) => warn('daily diary ledger append failed', err));
      } else {
        warn('daily diary to-you failed', toYou?.error || toYou);
      }
    }
    if (written.length) {
      await saveConfigAuto(home, { proactive: { lastDiaryDateKey: lastKey } });
      pushEvent('memory-progress', { stage: 'done', work: 'diary', ids: [] });
    }
    return { ok: true, wrote: written.length > 0, dates: written, reason: pending.reason };
  }

  // v3 (§5): one patrol per local day. Overdue-by->3d promises become an ask that
  // bypasses the slot gate (a trust event, not small talk); due-today promises only
  // speak when the evening slot already opened.
  async function runPromisePatrolIfDue({ conf, cfg, tz, at, plan, mute = false }) {
    if ((cfg.promisePatrol ?? true) === false) return { ok: true, ran: false, reason: 'disabled' };
    const { dateKey } = localClock(at, tz);
    if ((conf.proactive?.lastPromisePatrol ?? '') === dateKey) return { ok: true, ran: false, reason: 'already-today' };
    const { promises } = await listTrustItems(home, { nowMs: at });
    const targets = promisePatrolTargets({ promises, nowMs: at });
    await saveConfigAuto(home, { proactive: { lastPromisePatrol: dateKey } });
    if (!targets.length) return { ok: true, ran: true, targets: 0, speak: false };
    const ask = targets.find((t) => t.patrol === 'ask');
    const speak = !mute && (ask ? true : plan.speak === true && plan.kind === 'evening');
    if (!speak) return { ok: true, ran: true, targets: targets.length, speak: false, muted: mute };
    const target = ask ?? targets[0];
    const callUser = String(conf.persona?.callUser ?? '').trim() || '你';
    const text = ask
      ? `${callUser}，「${clip(target.text, 40)}」——说好 ${String(target.dueAt ?? '').slice(0, 10)} 前的，还作数吗？不作数我就把它放掉，不算你失约。`
      : `${callUser}，今天到期：「${clip(target.text, 40)}」。要现在做吗？`;
    const delivery = await deliverNudge(
      {
        speak: true,
        kind: ask ? 'promise-ask' : 'promise-patrol',
        text,
        dateKey,
        dedupeKey: `${dateKey}:promise`,
        at: new Date(at).toISOString(),
      },
      { deliver: hostDeliverer(), pushEvent: (type, extra) => pushEvent(type, extra) }
    );
    await appendJsonl(home.proactiveLogPath, {
      at: new Date(at).toISOString(),
      dateKey,
      kind: ask ? 'promise-ask' : 'promise-patrol',
      speak: true,
      promise: target.id,
      delivered: delivery.via,
    }).catch((err) => warn('promise patrol ledger append failed', err));
    pushEvent('promise-patrol', { ids: [target.id], ask: Boolean(ask) });
    return { ok: true, ran: true, targets: targets.length, speak: true, via: delivery.via, ask: Boolean(ask) };
  }

  /**
   * One scheduler tick: decide → deliver → maybe dream → maybe run the weekly gate.
   * Accepts an explicit `nowMs` so hosts and tests can drive it deterministically.
   */
  async function runProactiveTick(nowMs = Date.now()) {
    const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const conf = await loadConfig(home);
    const cfg = conf.proactive ?? {};
    const tz = Number.isFinite(Number(cfg.tzOffsetMinutes)) ? Number(cfg.tzOffsetMinutes) : 480;
    const [state, engine] = await Promise.all([
      loadSoulmateState(home, at),
      // Pass the live prompt: without it the budget block reports static percentages,
      // which is exactly the display-only behaviour it was built to replace.
      getEngineSnapshot(home, at, { promptText: promptEngine.promptText }).catch(() => null),
    ]);
    const strategy = engine?.scheduling?.strategy ?? {};

    const plan = evaluateOpeningGate({
      nowMs: at,
      tzOffsetMinutes: tz,
      strategy,
      state,
      config: cfg,
      recent: await proactiveRecent(),
      persona: conf.persona,
    });

    const intentOn = cfg.intentEnabled === true;
    let delivery = { ok: true, via: 'silent' };
    if (plan.speak && !intentOn) {
      delivery = await deliverNudge(plan, {
        deliver: hostDeliverer(plan),
        // No host channel: the 3D home still shows the bubble, and the audit log records it.
        pushEvent: (type, extra) => pushEvent(type, extra),
      });
      // A cap-blocked greeting is not a delivered one: say so instead of logging `host`.
      if (delivery?.blocked) {
        delivery = { ok: false, via: 'silent', blocked: true, reason: delivery.reason };
      }
    }
    await noteProactive(plan, intentOn && plan.speak ? 'intent-source' : delivery.via);

    // Night dream: distill today's loose facts into one Wiki page while she "sleeps".
    const dream = await runDreamIfDue({ conf, cfg, tz, at, persona: conf.persona });
    // Daily diary: one letter per local day (catch-up fills missed yesterday/today).
    const diary = await runDailyDiaryIfDue({ conf, cfg, tz, at, persona: conf.persona });
    const gate = await growth.runWeeklyGateIfDue({ cfg, at });
    // Experience pass rides the weekly gate: her attempts × his responses → lessons.
    let exp = { ok: true, ran: false, reason: 'gate-not-due' };
    if (gate.ran) {
      exp = await experience.runExperienceIfDue({ week: gate.week, at, conf }).catch((err) => {
        warn('experience pass failed', err);
        return { ok: false, ran: false, reason: 'error', error: errMsg(err) };
      });
    }
    // v3 (§5/§7): the promise patrol and the weekly distillation check ride this tick.
    // With intent on, the patrol still runs its ledger bookkeeping but never speaks —
    // due promises reach her as opportunities and the wording is hers.
    const patrol = await runPromisePatrolIfDue({ conf, cfg, tz, at, plan, mute: intentOn });
    const autoSurf = await surf.runAutoSurfIfDue({ conf, tz, at });
    // Intent pass rides after surf so this round's finds are immediate opportunities.
    let intentRes = { ok: true, ran: false, reason: 'disabled' };
    if (intentOn) {
      try {
        intentRes = await intent.runIntentIfDue({
          conf,
          cfg,
          tz,
          at,
          plan,
          surfResult: autoSurf?.ran
            ? { ran: true, picked: autoSurf.picked ?? 0, videos: autoSurf.surfVideos ?? [] }
            : null,
        });
      } catch (err) {
        intentRes = { ok: false, ran: false, reason: 'error', error: errMsg(err) };
        warn('intent pass failed', err);
      }
    }
    // IM proactive: whitelist-gated first messages, her angle when intent produced one.
    let imRes = { ok: true, ran: false, reason: 'disabled' };
    try {
      imRes = await imProactive.runImProactiveIfDue({
        at,
        angle: intentRes?.ran && intentRes.action && intentRes.action !== 'silent' && intentRes.action !== 'defer'
          ? str(intentRes.angle || intentRes.reason)
          : '',
      });
    } catch (err) {
      imRes = { ok: false, ran: false, reason: 'error', error: errMsg(err) };
      warn('im proactive pass failed', err);
    }
    let qqBridgeRes = { ok: true, ran: false, reason: 'skipped' };
    try {
      qqBridgeRes = await qqbotBridge.runQqbotBridgeIfEnabled();
    } catch (err) {
      qqBridgeRes = { ok: false, ran: false, reason: 'error', error: errMsg(err) };
      warn('qqbot bridge pass failed', err);
    }
    // QQ 图片入站 → vision 描述（时间线与记忆星可读图片内容）。
    let qqVision = { ok: true, ran: false, reason: 'skipped' };
    try {
      const controller = typeof chatHome.getSessionController === 'function' ? chatHome.getSessionController() : null;
      const { createHostVisionSummarize } = await import('../../soulmate-bili/host-vision.mjs');
      const describe = createHostVisionSummarize({
        controller,
        chatHome,
        fetchImpl: cfg?.imFetch || cfg?.fetch,
        soulmateRoot: home.rootDir,
        warn,
      });
      qqVision = await runQqVisionIfEnabled({ home, warn, describe });
    } catch (err) {
      qqVision = { ok: false, ran: false, reason: 'error', error: errMsg(err) };
      warn('qq vision pass failed', err);
    }
    let autoReply = { ok: true, ran: false, reason: 'skipped' };
    try {
      autoReply = await runAutoReplyPatrol(home, {
        nowMs: at,
        ...(cfg?.biliFetch ? { fetchImpl: cfg.biliFetch } : {}),
        voiceOf: (persona) => personaVoiceBrief(persona, state),
        authorReply: biliLlm.authorReply,
      });
    } catch (err) {
      autoReply = { ok: false, error: errMsg(err) };
      warn('auto-reply patrol failed', err);
    }
    const distill = gate.ran ? await runDistillationCheck({ cfg, at }) : { ok: true, ran: false, reason: 'weekly-gate-not-due' };
    // 周记润色顺带提炼本周兴趣关键词(追加式,不动手填词)
    if (gate.ran) {
      try {
        await refreshSurfKeywords(home, {
          nowMs: at,
          oneShotLlm,
          listHostModels,
          sessionController: typeof chatHome.getSessionController === 'function' ? chatHome.getSessionController : undefined,
        });
      } catch (err) { warn('weekly keyword refresh failed', err); }
    }
    // Session stars: poll watch list (+ discover) at the same tick level as dream.
    const sessionStars = await maybeCaptureSessionStars({ at }).catch((err) => {
      warn('maybeCaptureSessionStars failed', err);
      return { ok: false, error: errMsg(err) };
    });

    return { ok: true, at: new Date(at).toISOString(), plan, delivery, dream, diary, gate, patrol, autoSurf, autoReply, distill, sessionStars, intent: intentRes, imProactive: imRes, qqbotBridge: qqBridgeRes, qqVision, experience: exp, ...priceInfo(at) };
  }

  return { runProactiveTick, proactiveRecent, priceInfo, syncQqbotBridge: () => qqbotBridge.runQqbotBridgeIfEnabled(), qqOps };
}
