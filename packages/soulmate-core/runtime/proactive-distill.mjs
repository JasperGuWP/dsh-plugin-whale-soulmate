// Weekly distillation pass: cluster public facts → candidate wiki topics, with
// optional budget-capped LLM polish. Split out of proactive-runtime.mjs to keep
// every runtime module under the 600-line ceiling.

import { appendJsonl, saveConfigAuto } from '../state.mjs';
import { listWikiPages } from '../memory-engine.mjs';
import { estimateTokens } from '../budget.mjs';
import { composeDistillLlmPrompt, distillClusters, parseDistillLlmReply } from '../proactive.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { str } from '../small-utils.mjs';

export function createProactiveDistill({ home, warn, pushEvent, usage, loadFactsForDream }) {
  const { meteredCall, listHostModels, oneShotLlm, kindBudget } = usage;

  // Budget exhausted → auto-off the feature so tomorrow starts clean.
  async function maybeAutoOffLlm(feature, remaining, at) {
    if (remaining > 0) return;
    const patch =
      feature === 'dream'
        ? {
            dreamLlmEnabled: false,
            dreamLlmAutoOffReason: 'budget-exhausted',
            dreamLlmAutoOffAt: new Date(at).toISOString(),
          }
        : {
            distillLlmEnabled: false,
            distillLlmAutoOffReason: 'budget-exhausted',
            distillLlmAutoOffAt: new Date(at).toISOString(),
          };
    await saveConfigAuto(home, { proactive: patch });
    pushEvent('llm-budget-exhausted', { feature, at: patch.dreamLlmAutoOffAt || patch.distillLlmAutoOffAt });
  }

  async function runDistillationCheck({ cfg: pCfg, at }) {
    if ((pCfg.distillCheck ?? true) === false) return { ok: true, ran: false, reason: 'disabled' };
    const [facts, wiki] = await Promise.all([
      loadFactsForDream().catch(() => []),
      listWikiPages(home).catch(() => []),
    ]);
    const clusters = distillClusters({
      facts,
      wikiPages: wiki,
      minCluster: Number(pCfg.distillMinCluster) || 5,
    });
    if (!clusters.length) return { ok: true, ran: true, clusters: 0 };

    const llmOn = pCfg.distillLlmEnabled === true;
    let models = [];
    let picked = { id: '' };
    let budget = { allow: false, remaining: 0 };
    if (llmOn) {
      const cap = Number(pCfg.distillLlmDailyCap) || 0;
      budget = await kindBudget('distill-llm', cap, at);
      models = await listHostModels();
      picked = resolveLlmModel({ models, preferredId: pCfg.distillLlmModel || '' });
      if (!budget.allow) await maybeAutoOffLlm('distill', 0, at);
    }

    let polished = 0;
    for (const c of clusters) {
      let title = c.title;
      let summary = '';
      let via = 'cluster';
      if (llmOn && budget.allow && picked.id) {
        const draft = composeDistillLlmPrompt({ cluster: c });
        const need = estimateTokens(draft.prompt) + 200;
        if (budget.remaining >= need) {
          try {
            const metered = await meteredCall({
              kind: 'distill-llm',
              trigger: 'auto',
              prompt: draft.prompt,
              call: () => oneShotLlm({ prompt: draft.prompt, modelId: picked.id, kind: 'distill-llm' }),
            });
            if (metered.ok && !metered.blocked) {
              const text = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
              const parsed = parseDistillLlmReply(text, { fallbackTitle: c.title });
              if (parsed?.title) {
                title = parsed.title;
                summary = parsed.summary || '';
                via = 'llm';
                polished += 1;
                const spent = Number(metered.usage?.totalTokens) || estimateTokens(draft.prompt) + estimateTokens(text);
                budget = {
                  ...budget,
                  remaining: Math.max(0, budget.remaining - spent),
                  allow: budget.remaining - spent > 0,
                };
                await maybeAutoOffLlm('distill', budget.remaining, at);
              }
            } else if (metered.blocked) {
              await maybeAutoOffLlm('distill', 0, at);
              budget = { ...budget, allow: false, remaining: 0 };
            }
          } catch (err) {
            warn('distill llm polish skipped', err);
          }
        }
      }
      await appendJsonl(home.candidatesPath, {
        at: new Date(at).toISOString(),
        kind: 'distill',
        category: c.category,
        title,
        summary,
        sourceFactIds: c.sourceFactIds,
        via,
      }).catch((err) => warn('distill candidate append failed', err));
    }
    pushEvent('distill-candidates', { count: clusters.length, polished });
    return { ok: true, ran: true, clusters: clusters.length, polished };
  }

  return { runDistillationCheck, maybeAutoOffLlm };
}
