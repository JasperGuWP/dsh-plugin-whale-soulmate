// Experience runtime: weekly pairing of her proactive attempts with his responses,
// distilled into first-person lessons that ride the intent prompt.
//
// Files: logs/interactions.jsonl (his turns, appended by memory-service),
//        logs/intent-decisions.jsonl (her attempts, appended by intent-runtime),
//        memory/experience.json (the lessons; deleting this file = unlearn everything,
//        traits untouched — that isolation is the design's safety property).

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, readJsonlTail } from '../state.mjs';
import {
  aggregateExperience,
  composeExperienceNotes,
  experiencePromptBlock,
  mergeExperienceNotes,
  pairOutcomes,
} from '../experience.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { estimateTokens } from '../budget.mjs';
import { str } from '../small-utils.mjs';

const str0 = (v) => (typeof v === 'string' ? v : '');

export function createExperienceRuntime({ home, warn, pushEvent, usage }) {
  const { meteredCall, listHostModels, oneShotLlm, kindBudget } = usage;
  const storePath = join(home.rootDir, 'memory', 'experience.json');
  const interactionsPath = join(home.rootDir, 'logs', 'interactions.jsonl');
  const decisionsPath = join(home.rootDir, 'logs', 'intent-decisions.jsonl');

  async function loadStore() {
    try {
      const data = JSON.parse(await readFile(storePath, 'utf8'));
      return { notes: Array.isArray(data?.notes) ? data.notes : [], lastRunWeek: str0(data?.lastRunWeek) };
    } catch {
      return { notes: [], lastRunWeek: '' };
    }
  }

  async function saveStore(store) {
    await atomicWriteJson(storePath, { notes: store.notes, lastRunWeek: store.lastRunWeek, updatedAt: new Date().toISOString() });
  }

  /** The prompt block for the intent layer (and IM proactive). Soft-fails to ''. */
  async function experienceBlock() {
    const store = await loadStore();
    return experiencePromptBlock(store.notes);
  }

  /**
   * Weekly pass, riding the growth gate. `week` is the ISO week key; idempotent per week.
   * The LLM only rephrases deterministic lessons in her voice — it cannot invent facts:
   * every note keeps its numeric evidence and the fallback is always available.
   */
  async function runExperienceIfDue({ week, at, conf }) {
    if (!week) return { ok: true, ran: false, reason: 'no-week' };
    const cfg = conf?.proactive ?? {};
    if (cfg.experienceEnabled === false) return { ok: true, ran: false, reason: 'disabled' };
    const store = await loadStore();
    if (store.lastRunWeek === week) return { ok: true, ran: false, reason: 'already-this-week' };

    const [decisions, interactions] = await Promise.all([
      readJsonlTail(decisionsPath, 400).catch(() => []),
      readJsonlTail(interactionsPath, 800).catch(() => []),
    ]);
    const tz = Number(cfg.tzOffsetMinutes) || 480;
    const attempts = decisions
      .filter((d) => d && d.delivered && d.delivered !== 'silent' && d.delivered !== 'defer')
      .map((d) => ({
        ...d,
        hour: (() => {
          const t = Date.parse(d.at);
          if (!Number.isFinite(t)) return 0;
          const shifted = new Date(t + tz * 60_000);
          return shifted.getUTCHours();
        })(),
      }));
    const outcomes = pairOutcomes(attempts, interactions.map((r) => r?.at));
    const stats = aggregateExperience(outcomes);
    let notes = composeExperienceNotes(stats, { persona: conf?.persona ?? {} });

    // Optional voice polish: same facts, her phrasing. Budget-capped, falls back silently.
    if (notes.length && cfg.experienceLlmEnabled !== false) {
      try {
        const budget = await kindBudget('experience-llm', Number(cfg.experienceLlmDailyCap) || 30_000, at);
        const models = await listHostModels().catch(() => []);
        const picked = resolveLlmModel({ models, preferredId: '' });
        if (budget.allow && picked.id) {
          const voice = personaVoiceBrief(conf?.persona ?? {}, {});
          const prompt = [
            `把下面的相处观察改写成第一人称的相处心得（自称「${str(conf?.persona?.selfRef) || '我'}」）。`,
            voice ? `【你的性格】${voice}` : '',
            '要求：每条一行、保留原意与次数、口吻像自己记下的经验而不是规则；不要新增事实。',
            '只输出改写后的行，一行一条。',
            ...notes.map((n) => `- ${n.text}`),
          ].join('\n');
          if (budget.remaining >= estimateTokens(prompt) + 300) {
            const metered = await meteredCall({
              kind: 'experience-llm',
              trigger: 'auto',
              prompt,
              call: () => oneShotLlm({ prompt, modelId: picked.id, kind: 'experience-llm' }),
            });
            if (metered.ok && !metered.blocked) {
              const raw = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
              const lines = raw.split(/\r?\n/).map((l) => l.replace(/^[-•\s]+/, '').trim()).filter(Boolean);
              if (lines.length === notes.length) {
                notes = notes.map((n, i) => ({ ...n, text: lines[i].slice(0, 160) }));
              }
            }
          }
        }
      } catch (err) {
        warn('experience polish failed; deterministic notes kept', err);
      }
    }

    const merged = mergeExperienceNotes(store.notes, notes, at);
    await saveStore({ notes: merged, lastRunWeek: week });
    if (notes.length) pushEvent('experience', { learned: notes.length, total: merged.length });
    return { ok: true, ran: true, week, learned: notes.length, total: merged.length, samples: outcomes.length };
  }

  return { runExperienceIfDue, experienceBlock, loadStore, storePath };
}