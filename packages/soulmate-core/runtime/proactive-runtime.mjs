// The proactive executor: one scheduler tick decides → delivers → maybe dreams →
// maybe runs the weekly gate. The gate logic itself stays pure in proactive.mjs;
// this module owns the I/O (ledger, wiki writes, LLM calls, config bookkeeping).

import { readFile } from 'node:fs/promises';
import { appendJsonl, loadConfig, readJsonlTail, saveConfigAuto } from '../state.mjs';
import { getDisplayName, getNotebookTitles, loadSoulmateState } from '../persona.mjs';
import { listSessionEpisodes, listTrustItems, recordEpisode as recordEpisodeImpl, reflectToWiki } from '../memory-engine.mjs';
import { getEngineSnapshot, runSubmissionGate } from '../layers/index.mjs';
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
  shouldAutoSurf,
  shouldDream,
  shouldRunWeeklyGate,
} from '../proactive.mjs';
import { runAutonomousSurfRound } from '../../soulmate-bili/index.mjs';
import { refreshSurfKeywords } from '../../soulmate-bili/keyword-learn.mjs';
import { runAutoReplyPatrol } from '../../soulmate-bili/reply-patrol.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';
import { priceInfo } from './chat-home-runtime.mjs';
import { createProactiveDistill } from './proactive-distill.mjs';

export function createProactiveRuntime({
  home,
  warn,
  pushEvent,
  promptEngine,
  usage,
  chatHome,
  cfg,
}) {
  const { meteredCall, listHostModels, oneShotLlm, kindBudget } = usage;
  const { hostDeliverer, maybeCaptureSessionStars, chatHomeStatus, notePetSay } = chatHome;

  // Distillation pass + budget auto-off live in their own module.
  const { runDistillationCheck, maybeAutoOffLlm } = createProactiveDistill({ home, warn, pushEvent, usage, loadFactsForDream });

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
    }
    return { ok: true, wrote: written.length > 0, dates: written, reason: pending.reason };
  }

  // v3 (§5): one patrol per local day. Overdue-by->3d promises become an ask that
  // bypasses the slot gate (a trust event, not small talk); due-today promises only
  // speak when the evening slot already opened.
  async function runPromisePatrolIfDue({ conf, cfg, tz, at, plan }) {
    if ((cfg.promisePatrol ?? true) === false) return { ok: true, ran: false, reason: 'disabled' };
    const { dateKey } = localClock(at, tz);
    if ((conf.proactive?.lastPromisePatrol ?? '') === dateKey) return { ok: true, ran: false, reason: 'already-today' };
    const { promises } = await listTrustItems(home, { nowMs: at });
    const targets = promisePatrolTargets({ promises, nowMs: at });
    await saveConfigAuto(home, { proactive: { lastPromisePatrol: dateKey } });
    if (!targets.length) return { ok: true, ran: true, targets: 0, speak: false };
    const ask = targets.find((t) => t.patrol === 'ask');
    const speak = ask ? true : plan.speak === true && plan.kind === 'evening';
    if (!speak) return { ok: true, ran: true, targets: targets.length, speak: false };
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

  // v3 (§7 T2): weekly clustering of undistilled facts → submission-gate candidates.
  // Scheduled Bilibili patrol: read-only surf round on the auto-surf interval.
  // Watching writes local notes + seen ledger only; sharing / writes stay opt-in elsewhere.
  async function runAutoSurfIfDue({ conf, tz, at }) {
    const ext = conf.extensions ?? {};
    const decision = shouldAutoSurf({
      nowMs: at,
      tzOffsetMinutes: tz,
      config: { ...ext, quietHours: conf.proactive?.quietHours ?? [] },
      lastAutoSurfAt: ext.lastAutoSurfAt ?? '',
    });
    if (!decision.surf) return { ok: true, ran: false, reason: decision.reason };
    const maxPick = Math.min(5, Math.max(1, Math.floor(Number(ext.biliAutoSurfMaxPick) || 2)));
    const deepWatch = ext.biliAutoSurfDeepWatch === true;
    let keywordsRefresh = null;
    try {
      keywordsRefresh = await refreshSurfKeywords(home, {
        nowMs: at,
        oneShotLlm,
        listHostModels,
        sessionController: typeof chatHome.getSessionController === 'function'
          ? chatHome.getSessionController
          : undefined,
      });
    } catch (err) {
      warn('surf keyword refresh failed', err);
      keywordsRefresh = { ok: false, error: errMsg(err) };
    }
    const live = await loadConfig(home).catch(() => conf);
    const keywords = Array.isArray(live?.extensions?.biliKeywords) ? live.extensions.biliKeywords : ext.biliKeywords;
    let res;
    try {
      res = await runAutonomousSurfRound(
        { home },
        {
          maxPick,
          deepWatch,
          keywords,
          ...(cfg?.biliFetch ? { fetchImpl: cfg.biliFetch } : {}),
          ...(cfg?.biliBaseUrl ? { baseUrl: cfg.biliBaseUrl } : {}),
        }
      );
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    // Stamp the attempt even on failure so a broken network cannot retry every tick.
    await saveConfigAuto(home, { extensions: { lastAutoSurfAt: new Date(at).toISOString() } });
    await appendJsonl(home.proactiveLogPath, {
      at: new Date(at).toISOString(),
      dateKey: decision.dateKey,
      kind: 'auto-surf',
      speak: false,
      reason: decision.reason,
      delivered: res.ok ? 'watched' : 'failed',
      picked: res.pickedCount ?? 0,
      keywordsChanged: keywordsRefresh?.changed === true,
      keywords: Array.isArray(keywordsRefresh?.keywords) ? keywordsRefresh.keywords.slice(0, 8) : undefined,
    }).catch((err) => warn('auto-surf ledger append failed', err));
    if (res.ok && (res.pickedCount ?? 0) > 0) {
      pushEvent('video-surf', {
        auto: true,
        deepWatch,
        pickedCount: res.pickedCount,
        keywords: Array.isArray(keywords) ? keywords.slice(0, 8) : undefined,
        videos: (res.videos || []).filter((v) => v.ok).slice(0, 3).map((v) => (
          deepWatch
            ? { title: v.title, worthScore: v.worthScore, depth: v.coverage?.depth, howIWatched: v.howIWatched }
            : { title: v.title, worthScore: v.worthScore }
        )),
      });
    }
    return {
      ok: res.ok !== false,
      ran: true,
      picked: res.pickedCount ?? 0,
      reason: decision.reason,
      error: res.error,
      keywordsRefresh,
    };
  }

  async function runWeeklyGateIfDue({ cfg, at }) {
    const lastGateWeek = (await loadConfig(home)).proactive?.lastGateWeek ?? '';
    const due = shouldRunWeeklyGate({ nowMs: at, config: cfg, lastGateWeek });
    if (!due.run) return { ok: true, ran: false, reason: due.reason, week: due.week };
    const res = await runSubmissionGate(home, { nowMs: at }).catch((err) => ({ ok: false, error: errMsg(err) }));
    await saveConfigAuto(home, { proactive: { lastGateWeek: due.week } });
    return { ok: res.ok !== false, ran: true, week: due.week, applied: res.applied ?? null, reason: res.reason ?? '' };
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

    let delivery = { ok: true, via: 'silent' };
    if (plan.speak) {
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
    await noteProactive(plan, delivery.via);

    // Night dream: distill today's loose facts into one Wiki page while she "sleeps".
    const dream = await runDreamIfDue({ conf, cfg, tz, at, persona: conf.persona });
    // Daily diary: one letter per local day (catch-up fills missed yesterday/today).
    const diary = await runDailyDiaryIfDue({ conf, cfg, tz, at, persona: conf.persona });
    const gate = await runWeeklyGateIfDue({ cfg, at });
    // v3 (§5/§7): the promise patrol and the weekly distillation check ride this tick.
    const patrol = await runPromisePatrolIfDue({ conf, cfg, tz, at, plan });
    const autoSurf = await runAutoSurfIfDue({ conf, tz, at });
    let autoReply = { ok: true, ran: false, reason: 'skipped' };
    try {
      autoReply = await runAutoReplyPatrol(home, {
        nowMs: at,
        ...(cfg?.biliFetch ? { fetchImpl: cfg.biliFetch } : {}),
      });
    } catch (err) {
      autoReply = { ok: false, error: errMsg(err) };
      warn('auto-reply patrol failed', err);
    }
    const distill = gate.ran ? await runDistillationCheck({ cfg, at }) : { ok: true, ran: false, reason: 'weekly-gate-not-due' };
    // Session stars: poll watch list (+ discover) at the same tick level as dream.
    const sessionStars = await maybeCaptureSessionStars({ at }).catch((err) => {
      warn('maybeCaptureSessionStars failed', err);
      return { ok: false, error: errMsg(err) };
    });

    return { ok: true, at: new Date(at).toISOString(), plan, delivery, dream, diary, gate, patrol, autoSurf, autoReply, distill, sessionStars, ...priceInfo(at) };
  }

  return { runProactiveTick, proactiveRecent, priceInfo };
}
