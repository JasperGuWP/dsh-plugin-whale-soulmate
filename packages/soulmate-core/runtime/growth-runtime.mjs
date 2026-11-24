// Growth snapshots: one lightweight row per ISO week when the submission gate runs.
// This is the raw material the star-sea trajectory view replays — traits before/after,
// graph size, accepted candidates. History cannot be backfilled, so it starts accumulating
// the week this ships.

import { join } from 'node:path';
import { appendJsonl, loadConfig, saveConfigAuto } from '../state.mjs';
import { buildNeuralGraph } from '../memory-engine.mjs';
import { runSubmissionGate } from '../layers/index.mjs';
import { shouldRunWeeklyGate } from '../proactive.mjs';
import { errMsg, str } from '../small-utils.mjs';

export function createGrowthRuntime({ home, warn }) {
  const growthPath = join(home.rootDir, 'logs', 'growth.jsonl');

  async function runWeeklyGateIfDue({ cfg, at }) {
    const lastGateWeek = (await loadConfig(home)).proactive?.lastGateWeek ?? '';
    const due = shouldRunWeeklyGate({ nowMs: at, config: cfg, lastGateWeek });
    if (!due.run) return { ok: true, ran: false, reason: due.reason, week: due.week };
    const res = await runSubmissionGate(home, { nowMs: at }).catch((err) => ({ ok: false, error: errMsg(err) }));
    await saveConfigAuto(home, { proactive: { lastGateWeek: due.week } });
    try {
      const live = await loadConfig(home);
      const graph = await buildNeuralGraph(home, { nowMs: at }).catch(() => null);
      await appendJsonl(growthPath, {
        week: due.week,
        at: new Date(at).toISOString(),
        traits: live.persona?.traits ?? {},
        preset: str(live.persona?.preset),
        applied: res.applied ? { before: res.applied.before, after: res.applied.after } : null,
        accepted: Array.isArray(res.accepted) ? res.accepted.length : 0,
        nodes: graph?.nodes?.length ?? 0,
        wikiStars: (graph?.nodes ?? []).filter((n) => n.kind === 'wiki_star').length,
        facts: (graph?.nodes ?? []).filter((n) => n.kind === 'fact_neuron').length,
      });
    } catch (err) {
      warn('growth snapshot append failed', err);
    }
    return { ok: res.ok !== false, ran: true, week: due.week, applied: res.applied ?? null, reason: res.reason ?? '' };
  }

  return { runWeeklyGateIfDue, growthPath };
}