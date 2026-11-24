// Intent executor: ledger I/O → cheap gate → one metered decision call → deliver / restrain.
// Pure decisions live in ../intent.mjs; this module owns files, budget and the host channel.
//
// Failure posture: every step soft-fails. A broken ledger, model or host must degrade to
// the old schedule-gate behaviour, never crash the tick.

import { join } from 'node:path';
import { appendJsonl, loadConfig, readJsonlTail, saveConfigAuto } from '../state.mjs';
import { getNotebookTitles, loadSoulmateState } from '../persona.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { composePresenceDigest, listTrustItems, recordEpisode } from '../memory-engine.mjs';
import { deliverNudge, localClock, promisePatrolTargets } from '../proactive.mjs';
import { estimateTokens } from '../budget.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { clip, errMsg, str } from '../small-utils.mjs';
import {
  composeIntentPrompt,
  composeRestraintNote,
  evaluateIntentGate,
  expireEvents,
  makeIntentEvent,
  mergeEventLedger,
  parseIntentReply,
  resolveEvents,
} from '../intent.mjs';

const LEDGER_TAIL = 240;

export function createIntentRuntime({ home, warn, pushEvent, usage, chatHome, experienceBlock }) {
  const { meteredCall, listHostModels, oneShotLlm, kindBudget } = usage;
  const { hostDeliverer } = chatHome;
  const ledgerPath = join(home.rootDir, 'logs', 'intent-events.jsonl');
  const decisionLogPath = join(home.rootDir, 'logs', 'intent-decisions.jsonl');

  const readLedger = () => readJsonlTail(ledgerPath, LEDGER_TAIL).catch(() => []);
  const readDecisions = (limit = 40) => readJsonlTail(decisionLogPath, limit).catch(() => []);

  const persistRows = async (rows) => {
    // The ledger is append-only per resolution: rewrite-as-append keeps the jsonl discipline
    // (torn tail lines tolerated by readJsonlTail) while the tail read bounds replay cost.
    for (const row of rows) {
      await appendJsonl(ledgerPath, row).catch((err) => warn('intent ledger append failed', err));
    }
  };

  /** Latest row per event id wins — the append log is a resolution journal. */
  function collapseLedger(rows) {
    const byId = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r && r.id) byId.set(r.id, r);
    }
    return [...byId.values()];
  }

  /**
   * Produce fresh opportunities from signals that already exist. All 陈述句, no imperatives.
   * `plan` is the old opening-gate verdict: its slot becomes one opportunity among others.
   */
  async function produceEvents({ conf, cfg, tz, at, state, plan, surfResult }) {
    const fresh = [];
    const clock = localClock(at, tz);

    // The four windows, demoted: only offered when the *old* gate would also have spoken,
    // so intent never bypasses initiative floor / per-kind gap / daily quota.
    if (plan?.speak && plan.kind) {
      const label = { morning: '早安', lunch: '午饭', evening: '晚间', night: '催睡', sulking: '想念' }[plan.kind] || plan.kind;
      fresh.push(makeIntentEvent(plan.kind === 'sulking' ? 'sulking' : 'slot', {
        nowMs: at,
        key: `${clock.dateKey}:${plan.kind}`,
        payload: { slot: plan.kind, label, clock: clock.clock },
      }));
    }

    // Her own surf round just found something — the strongest share opportunity.
    if (surfResult?.ran && (surfResult.picked ?? 0) > 0 && Array.isArray(surfResult.videos)) {
      for (const v of surfResult.videos.slice(0, 2)) {
        if (!v || !v.title) continue;
        fresh.push(makeIntentEvent('video-found', {
          nowMs: at,
          key: `video:${str(v.bvid || v.title)}`,
          salience: Math.min(0.9, 0.45 + (Number(v.worthScore) || 0) / 40),
          payload: { title: str(v.title), worthScore: Number(v.worthScore) || 0, bvid: str(v.bvid), note: clip(str(v.howIWatched || v.summary), 120) },
        }));
      }
    }

    // Promises due/overdue (only when the daily patrol hasn't already spoken for them).
    if ((cfg.promisePatrol ?? true) !== false) {
      try {
        const { promises } = await listTrustItems(home, { nowMs: at });
        for (const t of promisePatrolTargets({ promises, nowMs: at }).slice(0, 2)) {
          fresh.push(makeIntentEvent('promise-due', {
            nowMs: at,
            key: `promise:${t.id}:${clock.dateKey}`,
            payload: { text: clip(str(t.text), 60), overdueDays: t.overdueDays ?? 0, dueAt: str(t.dueAt) },
          }));
        }
      } catch (err) {
        warn('intent: promise scan failed', err);
      }
    }

    // Long stretch without a break: lastInteractionAt is stamped every turn, so a fresh
    // stamp deep into the night means he is *still* at it. Numeric inference only.
    const lastMs = Date.parse(state?.lastInteractionAt);
    if (
      (state?.interactionCount ?? 0) > 0 &&
      Number.isFinite(lastMs) &&
      at - lastMs < 10 * 60_000 &&
      (clock.minutes >= 23 * 60 || clock.minutes < 5 * 60)
    ) {
      fresh.push(makeIntentEvent('long-active', {
        nowMs: at,
        key: `long-active:${clock.dateKey}:${Math.floor(clock.minutes / 60)}`,
        payload: { hours: clock.minutes >= 23 * 60 ? Math.round((clock.minutes - 18 * 60) / 60) : Math.round((clock.minutes + 6 * 60) / 60) },
      }));
    }
    return fresh;
  }

  /**
   * One intent pass. Returns a machine-readable summary for the tick result and the audit log.
   * `surfResult` optionally carries this tick's auto-surf picks (video-found opportunities).
   */
  async function runIntentIfDue({ conf, cfg, tz, at, plan, surfResult }) {
    const disabled = (reason) => ({ ok: true, ran: false, reason });
    if (cfg.intentEnabled !== true) return disabled('disabled');

    let state;
    try {
      state = await loadSoulmateState(home, at);
    } catch (err) {
      warn('intent: state load failed', err);
      state = {};
    }

    // 1. Ledger: collapse journal → expire → merge fresh opportunities.
    let rows = collapseLedger(await readLedger());
    const expired = expireEvents(rows, at);
    rows = expired.rows;
    const fresh = await produceEvents({ conf, cfg, tz, at, state, plan, surfResult });
    const merged = mergeEventLedger(rows, fresh);
    rows = merged.rows;
    const toAppend = [...merged.added];
    if (expired.changed) {
      toAppend.push(...rows.filter((r) => r.status === 'expired' && r.resolvedReason === 'ttl'));
    }

    // 2. Cheap gate.
    const decisions = await readDecisions();
    const gate = evaluateIntentGate({
      nowMs: at,
      tzOffsetMinutes: tz,
      config: cfg,
      state,
      events: rows,
      decisions,
    });
    if (!gate.consider) {
      await persistRows(toAppend);
      return { ...disabled(gate.reason), pending: rows.filter((r) => r.status === 'pending').length };
    }

    // 3. One metered decision call. Budget-blocked → defer silently, events stay pending.
    const cap = Number(cfg.intentLlmDailyCap) || 8;
    const budget = await kindBudget('intent-llm', cap, at);
    const models = await listHostModels().catch(() => []);
    const picked = resolveLlmModel({ models, preferredId: cfg.intentLlmModel || '' });
    let voice = '';
    let memory = '';
    let experience = '';
    try {
      voice = personaVoiceBrief(conf.persona, state);
      const digest = await composePresenceDigest(home, { maxChars: 500, gender: conf.persona?.gender ?? null });
      memory = digest.ok ? str(digest.text) : '';
      if (typeof experienceBlock === 'function') experience = await experienceBlock().catch(() => '');
    } catch (err) {
      warn('intent: voice/memory brief failed', err);
    }
    const clock = localClock(at, tz);
    const prompt = composeIntentPrompt({
      events: gate.events,
      voice,
      memory,
      experience,
      persona: conf.persona ?? {},
      clock: clock.clock,
      dateKey: clock.dateKey,
      recentDecisions: decisions,
    });
    const need = estimateTokens(prompt) + 300;
    if (!budget.allow || budget.remaining < need || !picked.id) {
      await persistRows(toAppend);
      return { ...disabled(!budget.allow ? 'budget-blocked' : 'no-model'), pending: gate.events.length };
    }

    let verdict;
    try {
      const metered = await meteredCall({
        kind: 'intent-llm',
        trigger: 'auto',
        prompt,
        call: () => oneShotLlm({ prompt, modelId: picked.id, kind: 'intent-llm' }),
      });
      if (!metered.ok || metered.blocked) {
        await persistRows(toAppend);
        return { ...disabled(metered.blocked ? 'daily-token-cap' : 'llm-failed') };
      }
      const text = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
      verdict = parseIntentReply(text, { events: gate.events });
    } catch (err) {
      warn('intent decision call failed', err);
      await persistRows(toAppend);
      return { ...disabled('llm-error'), error: errMsg(err) };
    }

    const event = gate.events.find((e) => e.id === verdict.eventId) || null;
    const decisionRow = {
      at: new Date(at).toISOString(),
      dateKey: clock.dateKey,
      clock: clock.clock,
      action: verdict.action,
      eventId: verdict.eventId,
      eventKind: event?.kind ?? '',
      angle: verdict.angle,
      reason: verdict.reason,
      steps: verdict.steps,
      parse: verdict.parse,
      offered: gate.events.map((e) => e.id),
      delivered: null,
    };

    // 4. Execute. speak/share/asks ride the existing wake channel; the angle becomes the
    //    wake hint so the dedicated window speaks *her* thought, not a template.
    if (verdict.action === 'silent' || verdict.action === 'defer') {
      const status = verdict.action === 'silent' ? 'declined' : 'pending';
      if (verdict.action === 'silent' && event) {
        toAppend.push(...resolveEvents([event], [event.id], 'declined', verdict.reason, at));
        // Restraint goes to the private notebook — where the user looks, never a toast.
        try {
          const note = composeRestraintNote({ decision: verdict, event, dateKey: clock.dateKey, clock: clock.clock, persona: conf.persona ?? {} });
          const innerTitle = getNotebookTitles(conf.persona).innerTitle;
          await recordEpisode(home, { ...note, notebookTitle: innerTitle, nowMs: at });
        } catch (err) {
          warn('intent restraint note failed', err);
        }
      } else if (verdict.action === 'defer' && event) {
        // defer keeps it pending but bumps attempts so it cannot loop forever.
        toAppend.push({ ...event, attempts: (Number(event.attempts) || 0) + 1, lastDeferredAt: new Date(at).toISOString() });
      }
      decisionRow.delivered = verdict.action;
      await persistRows(toAppend);
      await appendJsonl(decisionLogPath, decisionRow).catch((err) => warn('intent decision append failed', err));
      pushEvent('intent', { action: verdict.action, reason: verdict.reason, eventKind: event?.kind ?? '' });
      return { ok: true, ran: true, action: verdict.action, reason: verdict.reason, angle: verdict.angle, eventKind: event?.kind ?? '' };
    }

    const hint = verdict.angle || verdict.reason;
    const delivery = await deliverNudge(
      {
        speak: true,
        kind: `intent-${verdict.action}`,
        text: hint,
        dateKey: clock.dateKey,
        dedupeKey: `${clock.dateKey}:intent:${verdict.eventId}`,
        at: new Date(at).toISOString(),
        steps: verdict.steps,
      },
      { deliver: hostDeliverer({ ...plan, kind: `intent-${verdict.action}` }), pushEvent: (type, extra) => pushEvent(type, extra) }
    );
    decisionRow.delivered = delivery.via;
    if (delivery.ok && !delivery.blocked && event) {
      toAppend.push(...resolveEvents([event], [event.id], 'consumed', verdict.action, at));
    } else if (event) {
      toAppend.push({ ...event, attempts: (Number(event.attempts) || 0) + 1 });
    }
    await persistRows(toAppend);
    await appendJsonl(decisionLogPath, decisionRow).catch((err) => warn('intent decision append failed', err));
    return {
      ok: true,
      ran: true,
      action: verdict.action,
      reason: verdict.reason,
      angle: verdict.angle,
      eventKind: event?.kind ?? '',
      via: delivery.via,
      blocked: delivery.blocked === true,
    };
  }

  return { runIntentIfDue, readDecisions };
}