// Token metering: every model call appends one line to logs/usage.jsonl.
// Automatic work is additionally gated by a daily cap the user sets in the panel
// (config.usage.dailyAutoTokenCap). User-initiated calls are recorded but never refused.
// Also owns the panel's usage snapshot and the host-model catalogue probe.

import { loadConfig, saveConfigAuto } from '../state.mjs';
import {
  appendUsageRow,
  buildBlockedRow,
  buildUsageRow,
  checkDailyCap,
  checkKindDailyCap,
  normalizeUsage,
  readUsageRows,
  sumSessionAssistantUsage,
  summarizeUsage,
} from '../usage.mjs';
import { isChatModel, resolveLlmModel } from '../llm-model-pick.mjs';
import { errMsg, str } from '../small-utils.mjs';

export function createUsageRuntime({ home, cfg, warn, pushEvent, sessionController, getLlm, desktopSelection }) {
  const loadUsageConfig = async () => {
    const conf = await loadConfig(home);
    const u = conf.usage ?? {};
    const cap = Number(u.dailyAutoTokenCap);
    return {
      cap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0,
      onCapReached: u.onCapReached === 'warn' ? 'warn' : 'block',
      keepDays: Math.max(1, Math.floor(Number(u.keepDays) || 90)),
      tzOffsetMinutes: Number.isFinite(Number(conf.proactive?.tzOffsetMinutes))
        ? Number(conf.proactive.tzOffsetMinutes)
        : 480,
    };
  };

  const recordUsage = async (row) => {
    const res = await appendUsageRow(home.usagePath, row);
    if (!res.ok) warn('usage ledger append failed', res.error);
    return res;
  };

  /**
   * Ask the model, then record what it cost.
   *
   * `call` is the host's generateReply-shaped function; `prompt`/`reply` are used only for
   * the estimate fallback when the host does not report usage. A refused auto call writes a
   * `blocked` row so "she wanted to speak but the cap stopped her" stays explainable.
   */
  const meteredCall = async ({ kind, trigger, call, prompt, fallbackReply = '' }) => {
    const cfgUsage = await loadUsageConfig();
    let capCheck = { allow: true, reason: 'no-cap', used: 0, cap: cfgUsage.cap, remaining: Infinity };

    if (trigger === 'auto') {
      const rows = await readUsageRows(home.usagePath).catch(() => []);
      capCheck = checkDailyCap({
        rows,
        cap: cfgUsage.cap,
        trigger,
        kind,
        nowMs: Date.now(),
        tzOffsetMinutes: cfgUsage.tzOffsetMinutes,
      });
      if (!capCheck.allow) {
        // `warn` records the overage and still runs; `block` refuses outright.
        if (cfgUsage.onCapReached === 'block') {
          await recordUsage(buildBlockedRow({ kind, note: `daily token cap reached (${capCheck.used}/${capCheck.cap})` }));
          pushEvent('usage-blocked', { kind, used: capCheck.used, cap: capCheck.cap });
          return { ok: false, blocked: true, reason: 'daily-token-cap', used: capCheck.used, cap: capCheck.cap };
        }
      }
    }

    let out = null;
    let error = null;
    try {
      out = await call();
    } catch (err) {
      error = err;
    }

    const replyText = typeof out === 'string' ? out : str(out?.text);
    const usage = normalizeUsage(out);
    await recordUsage(
      buildUsageRow({
        kind,
        trigger,
        prompt: str(prompt),
        reply: replyText || str(fallbackReply),
        usage,
        note: error ? `call failed: ${errMsg(error)}` : capCheck.reason,
      }),
    );
    if (error) throw error;
    return { ok: true, out, usage, cap: capCheck };
  };

  async function listHostModels() {
    if (typeof cfg.listLlmModels === 'function') {
      try {
        return (await cfg.listLlmModels()) || [];
      } catch (err) {
        warn('listLlmModels inject failed', err);
        return [];
      }
    }
    try {
      const llm = getLlm?.();
      if (!llm) return [];
      if (typeof llm.modelCatalog === 'function') {
        const cat = await llm.modelCatalog();
        if (Array.isArray(cat)) return cat;
        if (Array.isArray(cat?.models)) return cat.models;
      }
      if (typeof llm.listModels === 'function') {
        const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
        if (!providers?.length) {
          const alone = await llm.listModels('');
          return Array.isArray(alone) ? alone : [];
        }
        const out = [];
        for (const p of providers) {
          const pid = typeof p === 'string' ? p : p?.id;
          if (!pid) continue;
          try {
            const models = await llm.listModels(pid);
            for (const m of models || []) out.push({ ...m, provider: pid });
          } catch {
            // skip one bad provider
          }
        }
        return out;
      }
    } catch (err) {
      warn('host model list failed', err);
    }
    return [];
  }

  /** One-shot text generation for dream/distill; injectable via cfg.llmOneShot for tests. */
  async function oneShotLlm({ prompt, modelId, kind }) {
    if (typeof cfg.llmOneShot === 'function') {
      return cfg.llmOneShot({ prompt, modelId, kind });
    }
    // User decision (2026-11-24): every internal call defaults to the model currently
    // selected in the DSH conversation picker. An explicit modelId (a per-feature
    // setting the user filled in) still wins; auto-cheapest is only the last resort.
    const live = typeof desktopSelection?.current === 'function' ? desktopSelection.current() : undefined;
    if (!str(modelId).trim() && live?.model) modelId = str(live.model);
    const controller = sessionController();
    if (typeof controller?.generateReply === 'function') {
      return controller.generateReply({ text: prompt, model: modelId, purpose: kind });
    }
    // Desktop hosts expose no generateReply. The real host `llm` service is an adapter
    // registry with a streaming API — llm.stream({provider, model, messages, …}) yields
    // text-delta / usage / finish chunks. (The earlier chat/complete guess never matched
    // this surface; a real install failed 139 IM proactive attempts in a row.)
    const llm = typeof getLlm === 'function' ? getLlm() : null;
    if (llm && typeof llm.stream === 'function') {
      let provider = str(live?.provider);
      let model = str(modelId);
      // The live selection already names its provider. With an explicit modelId but no
      // live provider, resolve that exact model's provider from the catalog — never a
      // different model. With neither, there is nothing the user selected: fail loudly.
      if (!provider && model) {
        try {
          const models = await listHostModels();
          const hit = models.find((m) => str(m?.id || m?.model || m?.name) === model && m?.provider);
          if (hit) provider = str(hit.provider);
        } catch { /* fall through */ }
      }
      if (!provider || !model) {
        throw new Error('[soulmate] no DSH model selection available — 请先在 DSH 会话里选择一个模型');
      }
      // Account-authenticated routes (deepseek-account) scope their token to a live
      // session; carrying the tracked session id lets the host attach the account
      // credential instead of falling back to a (possibly dead) API key.
      const liveSessionId = str(desktopSelection?.currentSessionId?.());
      const runStream = async (p, m, effort) => {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(90_000) : undefined;
        let text = '';
        let usage = null;
        const blocks = new Map();
        let finish = null;
        for await (const chunk of llm.stream({
          provider: p,
          model: m,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          purpose: kind,
          ...(liveSessionId && p === str(live?.provider) ? { sessionId: liveSessionId } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(signal ? { signal } : {}),
        })) {
          if (chunk?.type === 'text-delta') text += str(chunk.text);
          else if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage;
          else if (chunk?.type === 'block-end' && chunk.block) blocks.set(chunk.index, chunk.block);
          else if (chunk?.type === 'finish') finish = chunk.reason;
        }
        if (!text.trim()) {
          for (const b of blocks.values()) {
            if (b?.type === 'text' && str(b.text).trim()) { text = str(b.text); break; }
          }
        }
        return { text, usage, finish };
      };
      const effort = live?.reasoningEffort && str(model) === str(live.model) ? live.reasoningEffort : '';
      let { text, usage, finish } = await runStream(provider, model, effort);
      // User rule (final, 2026-11-24): default to the DSH-selected model; a failed route
      // MAY fall back to another chat route, but every reroute must be surfaced to the
      // user (toast + audit) — never a silent substitution.
      const retriable = (f) => f?.kind === 'error'
        && (/UNKNOWN_MODEL|AUTH|QUOTA|RATE|EXHAUST|INVALID/i.test(`${str(f.failure?.code)} ${str(f.failure?.message)}`));
      if (!text.trim() && retriable(finish)) {
        const fromRoute = `${provider}/${model}`;
        const fromReason = str(finish?.failure?.message) || str(finish?.failure?.code) || 'provider error';
        try {
          const models = await listHostModels();
          const tried = new Set([fromRoute]);
          const alts = models.filter((m) => m?.provider && isChatModel(m)
            && !tried.has(`${str(m.provider)}/${str(m.id || m.model || m.name)}`));
          alts.sort((a, b) => (str(b.provider) === provider ? 1 : 0) - (str(a.provider) === provider ? 1 : 0));
          for (const alt of alts.slice(0, 2)) {
            const ap = str(alt.provider);
            const am = str(alt.id || alt.model || alt.name);
            const r = await runStream(ap, am, '');
            provider = ap; model = am;
            text = r.text; usage = r.usage; finish = r.finish;
            if (text.trim()) {
              // Visible notice: the user must know this reply did NOT use their selection.
              pushEvent('llm-rerouted', {
                kind,
                from: fromRoute,
                to: `${ap}/${am}`,
                reason: fromReason.slice(0, 160),
              });
              warn(`llm rerouted for ${kind}: ${fromRoute} → ${ap}/${am} (${fromReason.slice(0, 80)})`);
              break;
            }
            if (!retriable(finish)) break;
          }
        } catch { /* keep original failure */ }
      }
      if (finish && finish.kind === 'error') {
        const f = finish.failure || {};
        throw new Error(`[soulmate] llm call failed on ${provider}/${model}: ${str(f.message) || 'provider error'}${f.code ? ` (${f.code})` : ''}`);
      }
      if (!text.trim()) {
        throw new Error(`[soulmate] llm stream returned no text (provider=${provider} model=${model})`);
      }
      return { text, usage };
    }
    if (llm && typeof llm.chat === 'function') {
      return llm.chat({ model: modelId, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], purpose: kind });
    }
    if (llm && typeof llm.complete === 'function') {
      return llm.complete({ model: modelId, prompt, purpose: kind });
    }
    throw new Error('[soulmate] no llm one-shot available');
  }

  async function kindBudget(kind, cap, at) {
    const rows = await readUsageRows(home.usagePath).catch(() => []);
    const tz = Number((await loadConfig(home)).proactive?.tzOffsetMinutes) || 480;
    return checkKindDailyCap({ rows, kind, cap, nowMs: at, tzOffsetMinutes: tz });
  }

  /**
   * Everything the Token 统计 tab needs: today's spend, the 7-day trend, per-kind split,
   * and the cap state. Estimates are flagged so the UI never presents a guess as a meter.
   */
  async function getUsageSnapshot(options = {}) {
    const cfgUsage = await loadUsageConfig();
    const all = await readUsageRows(home.usagePath).catch(() => []);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const today = summarizeUsage(all, { nowMs, tzOffsetMinutes: cfgUsage.tzOffsetMinutes });
    const cap = checkDailyCap({
      rows: all,
      cap: cfgUsage.cap,
      trigger: 'auto',
      nowMs,
      tzOffsetMinutes: cfgUsage.tzOffsetMinutes,
    });

    // 7-day trend, oldest first, so the panel can draw a sparkline without re-aggregating.
    const trend = [];
    for (let i = 6; i >= 0; i -= 1) {
      const dayMs = nowMs - i * 86_400_000;
      const s = summarizeUsage(all, { nowMs: dayMs, tzOffsetMinutes: cfgUsage.tzOffsetMinutes });
      trend.push({ dateKey: s.dateKey, totalTokens: s.totalTokens, autoTokens: s.autoTokens, userTokens: s.userTokens, calls: s.calls, blocked: s.blocked });
    }

    const conf = await loadConfig(home);
    const p = conf.proactive || {};
    const rows = all;
    const dreamKind = checkKindDailyCap({
      rows,
      kind: 'dream-llm',
      cap: Number(p.dreamLlmDailyCap) || 0,
      nowMs,
      tzOffsetMinutes: cfgUsage.tzOffsetMinutes,
    });
    const distillKind = checkKindDailyCap({
      rows,
      kind: 'distill-llm',
      cap: Number(p.distillLlmDailyCap) || 0,
      nowMs,
      tzOffsetMinutes: cfgUsage.tzOffsetMinutes,
    });
    let models = [];
    try {
      models = await listHostModels();
    } catch {
      models = [];
    }
    const dreamModel = resolveLlmModel({ models, preferredId: p.dreamLlmModel || '' });
    const distillModel = resolveLlmModel({ models, preferredId: p.distillLlmModel || '' });

    // Host「轨迹/统计」用量：专属对话窗回合合计（与插件自动账本分开，避免对话显示为 0）。
    let sessionChat = { ok: false, totalTokens: 0, promptTokens: 0, completionTokens: 0, turns: 0, withUsage: 0, sessionId: '' };
    try {
      const chatHome = conf.chatHome || {};
      const sessionId = String(chatHome.activeSessionId || '').trim();
      const controller = sessionController();
      if (sessionId && typeof controller?.events === 'function') {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(12_000)
          : new AbortController().signal;
        const page = await controller.events({
          address: { kind: 'session', sessionId },
          maxMessages: 80,
        }, signal);
        const summed = sumSessionAssistantUsage(page);
        sessionChat = { ...summed, sessionId, ok: true };
      }
    } catch (err) {
      sessionChat = { ...sessionChat, ok: false, error: errMsg(err) };
    }

    return {
      ok: true,
      at: new Date(nowMs).toISOString(),
      config: {
        dailyAutoTokenCap: cfgUsage.cap,
        onCapReached: cfgUsage.onCapReached,
        keepDays: cfgUsage.keepDays,
      },
      today,
      sessionChat,
      cap: { used: cap.used, limit: cap.cap, remaining: cap.remaining, reached: !cap.allow, unlimited: !(cap.cap > 0) },
      trend,
      ledgerPath: home.usagePath,
      llmBudgets: {
        dream: {
          enabled: p.dreamLlmEnabled === true,
          cap: dreamKind.cap,
          used: dreamKind.used,
          remaining: dreamKind.remaining,
          model: dreamModel.id,
          modelLabel: dreamModel.label,
          modelAuto: dreamModel.auto,
          autoOffReason: p.dreamLlmAutoOffReason || '',
        },
        distill: {
          enabled: p.distillLlmEnabled === true,
          cap: distillKind.cap,
          used: distillKind.used,
          remaining: distillKind.remaining,
          model: distillModel.id,
          modelLabel: distillModel.label,
          modelAuto: distillModel.auto,
          autoOffReason: p.distillLlmAutoOffReason || '',
        },
        models: models.map((m) => ({
          id: String(m.id || m.model || m.name || ''),
          label: String(m.displayName || m.title || m.name || m.id || ''),
        })).filter((m) => m.id),
      },
    };
  }

  /** Persist the cap knobs the panel exposes. Bad values fail loudly, never silently clamp. */
  async function setUsageConfig(patch = {}) {
    const allowed = ['dailyAutoTokenCap', 'onCapReached', 'keepDays'];
    const next = {};
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      next[key] = patch[key];
    }
    if (next.dailyAutoTokenCap !== undefined) {
      const n = Number(next.dailyAutoTokenCap);
      if (!Number.isFinite(n) || n < 0) throw new Error('[soulmate] usage.dailyAutoTokenCap must be a number >= 0 (0 = no cap)');
      next.dailyAutoTokenCap = Math.floor(n);
    }
    if (next.onCapReached !== undefined && !['block', 'warn'].includes(String(next.onCapReached))) {
      throw new Error('[soulmate] usage.onCapReached must be "block" or "warn"');
    }
    if (next.keepDays !== undefined) {
      const n = Number(next.keepDays);
      if (!Number.isFinite(n) || n < 1) throw new Error('[soulmate] usage.keepDays must be a number >= 1');
      next.keepDays = Math.floor(n);
    }
    if (Object.keys(next).length) await saveConfigAuto(home, { usage: next });
    return { ok: true, config: await loadUsageConfig() };
  }

  return { meteredCall, listHostModels, oneShotLlm, kindBudget, getUsageSnapshot, setUsageConfig, loadUsageConfig };
}
